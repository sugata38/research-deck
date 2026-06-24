// ============================================================
// ResearchDeck - Content Script
// 楽天市場の商品ページから情報を抽出し、
// SP-API経由でAmazonの利益・出品可否・販売数を表示するツール
// ============================================================

// コピー用SVGアイコン（重ね合わせたダブルスクエア記号。Lucide Copy icon）
const COPY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; display: inline-block; margin-left: 2px;"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;

// グローバル（モジュール）スコープでの状態管理変数
let currentAmazonData = null;
let currentAutoCoupon = 0;
let currentAutoExtraRate = 0;

// ============================================================
// 1. 楽天画面からのデータ抽出（スクレイピング）
// ============================================================

/**
 * JANコード（GTIN-13 / GTIN-8）のチェックデジットが正しいか検証する
 * 楽天の商品管理番号（ただの連番など）をJANコードと誤認するのを防ぐために使用します。
 * @param {string} code - 検証する数値文字列（8桁または13桁）
 * @returns {boolean} 正しいJANコードであればtrue
 */
function isValidJanCode(code) {
  if (!code) return false;
  if (!/^\d+$/.test(code)) return false;

  if (code.length === 13) {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      const digit = parseInt(code[i], 10);
      sum += (i % 2 === 0) ? digit : digit * 3;
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    return checkDigit === parseInt(code[12], 10);
  } else if (code.length === 8) {
    let sum = 0;
    for (let i = 0; i < 7; i++) {
      const digit = parseInt(code[i], 10);
      sum += (i % 2 === 0) ? digit * 3 : digit;
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    return checkDigit === parseInt(code[7], 10);
  }
  return false;
}

/**
 * JSON-LD (構造化データ) から JANコードと価格を抽出する
 * @param {Document} doc - 対象ドキュメント
 * @returns {Object|null} { jan, price } または null
 */
function extractFromJsonLd(doc) {
  const jsonLdEls = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const el of jsonLdEls) {
    try {
      const data = JSON.parse(el.textContent);
      const objects = Array.isArray(data) ? data : [data];
      for (const obj of objects) {
        if (obj && (obj["@type"] === "Product" || (typeof obj["@type"] === "string" && obj["@type"].includes("Product")))) {
          let jan = obj.gtin13 || obj.gtin8 || obj.gtin || obj.mpn || null;
          let price = null;
          
          if (obj.offers) {
            const offers = Array.isArray(obj.offers) ? obj.offers : [obj.offers];
            for (const offer of offers) {
              if (offer && offer.price) {
                const parsedPrice = parseInt(String(offer.price).replace(/[^0-9]/g, ""), 10);
                if (!isNaN(parsedPrice) && parsedPrice > 0) {
                  price = parsedPrice;
                  break;
                }
              }
            }
          }
          
          // JANコードの妥当性検証
          if (jan) {
            const match = String(jan).match(/\d+/);
            if (match && isValidJanCode(match[0])) {
              jan = match[0];
            } else {
              jan = null;
            }
          }
          
          if (jan || price) {
            return { jan, price };
          }
        }
      }
    } catch (e) {
      // パース失敗は無視
    }
  }
  return null;
}

/**
 * 楽天の商品ページからJANコード（バーコード番号）を抽出する
 * チェックデジットの検証を行い、不正な数値（管理用の型番や商品ID）の誤取得を排除します。
 * @returns {string|null} 正しいJANコード（13桁の数字または8桁）あるいはnull
 */
function extractJanCode(doc = document) {
  // --- 方法1: 商品説明テーブル内の「JAN」行を探す ---
  const tableRows = doc.querySelectorAll(
    "table tr, .item-description table tr, .rakutenLimitedId_ItemDescriptionInner table tr"
  );
  for (const row of tableRows) {
    const headerCell = row.querySelector("th, td:first-child");
    if (headerCell && /jan|ジャン|バーコード/i.test(headerCell.textContent)) {
      const valueCell = row.querySelector("td:last-child, td:nth-child(2)");
      if (valueCell) {
        // 13桁または8桁の数字を抽出
        const match = valueCell.textContent.match(/\d{13}|\d{8}/);
        if (match && isValidJanCode(match[0])) return match[0];
      }
    }
  }

  // --- 方法2: ページ全体のテキストから「JAN:数字」パターンを探す（改行や記号を考慮して強化） ---
  const bodyText = doc.body ? doc.body.textContent : "";
  const janPatterns = [
    /JAN(?:コード)?[\s:：\n\r]*(\d{13})/i,
    /バーコード[\s:：\n\r]*(\d{13})/i,
    /JAN(?:コード)?[\s:：\n\r]*(\d{8})/i,
    /バーコード[\s:：\n\r]*(\d{8})/i,
  ];

  for (const pattern of janPatterns) {
    const match = bodyText.match(pattern);
    if (match && isValidJanCode(match[1])) return match[1];
  }

  // ページ内の13桁の独立した数値をすべて抽出して検証（フォールバック）
  const allNumbers13 = bodyText.match(/\b\d{13}\b/g) || [];
  for (const num of allNumbers13) {
    if (isValidJanCode(num)) return num;
  }

  // ページ内の8桁 of 独立した数値をすべて抽出して検証（フォールバック）
  const allNumbers8 = bodyText.match(/\b\d{8}\b/g) || [];
  for (const num of allNumbers8) {
    if (isValidJanCode(num)) return num;
  }

  // --- 方法3: 商品番号（楽天独自の管理番号）を最終フォールバックとして取得（チェックデジット検証付き） ---
  const itemNumberEl = doc.querySelector(
    ".item-number span, .rakutenLimitedId_ItemNumber span"
  );
  if (itemNumberEl) {
    const numMatch = itemNumberEl.textContent.match(/\d+/);
    if (numMatch && isValidJanCode(numMatch[0])) return numMatch[0];
  }

  return null;
}

/**
 * 商品価格（税込）を抽出する
 * @returns {number} 税込価格（数値）。取得できない場合は0
 */
function extractPrice(doc = document) {
  // 1. メタタグからの抽出（SEO用の静的HTMLで極めて堅牢）
  const metaSelectors = [
    'meta[property="product:price:amount"]',
    'meta[itemprop="price"]',
    'meta[name="twitter:data1"]'
  ];
  
  for (const selector of metaSelectors) {
    const el = doc.querySelector(selector);
    if (el) {
      const content = el.getAttribute("content");
      if (content) {
        const num = parseInt(content.replace(/[^0-9]/g, ""), 10);
        if (!isNaN(num) && num > 0) return num;
      }
    }
  }

  // 2. 楽天でよく使われる価格表示セレクタ候補
  const priceSelectors = [
    // 新デザイン系
    ".primary--2kjQA", // 最新の価格クラス
    ".price--OX_YW",
    ".price2",
    "[class*='price'] .important",
    // 従来デザイン系
    ".price",
    ".item-price",
    "#priceCalculationConfig",
    ".rakutenLimitedId_ItemPrice",
    // 一般的なパターン
    'span[itemprop="price"]',
    ".sale_price",
  ];

  for (const selector of priceSelectors) {
    const el = doc.querySelector(selector);
    if (el) {
      // itemprop="price"の場合はcontent属性に数値が入っていることがある
      const contentAttr = el.getAttribute("content");
      if (contentAttr) {
        const num = parseInt(contentAttr, 10);
        if (!isNaN(num) && num > 0) return num;
      }

      // テキストからカンマや「円」を除去して数値化
      const text = el.textContent.replace(/[,、円税込（）()]/g, "").trim();
      const match = text.match(/\d+/);
      if (match) {
        const num = parseInt(match[0], 10);
        if (num > 0) return num;
      }
    }
  }

  return 0;
}

/**
 * 獲得予定ポイント数を抽出する
 * ユーザーがログインしている場合に表示される「〇〇ポイント」の数字
 * @returns {number} ポイント数。取得できない場合は0
 */
function extractPoints(doc = document) {
  // --- 1. 新アプローチ: 「内訳」というテキストを含む要素の周辺から数値を抽出（最も堅牢） ---
  const allElements = doc.getElementsByTagName("*");
  for (const el of allElements) {
    if (el.textContent && /^(内訳|ポイントの内訳)$/i.test(el.textContent.trim())) {
      // 「内訳」要素が見つかったら、その親要素（3階層上まで）を走査
      let parent = el.parentElement;
      for (let depth = 0; depth < 3; depth++) {
        if (!parent) break;
        const parentText = parent.textContent.replace(/[,、]/g, "");
        // 例: "582ポイント 内訳" または "582ポイント内訳" などのテキストから数値を抽出
        const match = parentText.match(/(\d+)\s*ポイント/);
        if (match) {
          const val = parseInt(match[1], 10);
          if (val > 0 && val < 1000000) {
            console.log("ResearchDeck: 「内訳」周辺の親要素からポイントを検出しました:", val);
            return val;
          }
        }
        parent = parent.parentElement;
      }
    }
  }

  // --- 2. ポイント表示エリアのセレクタ候補による抽出 ---
  const pointSelectors = [
    // 新デザイン系
    ".bdg-point-display", // 最新 of ポイント表示クラス
    ".getPoint",
    ".point-firing",
    "[class*='point'] .important",
    "[class*='deal'] .important", // スーパーDEAL対応
    // 従来デザイン系
    ".rakutenLimitedId_PointEarning",
    ".item-points",
    "#getPoint",
    // SPU（スーパーポイントアッププログラム）関連
    ".spu-point",
    ".point-total",
  ];

  for (const selector of pointSelectors) {
    const el = doc.querySelector(selector);
    if (el) {
      // 「最大1,234ポイント」や「1,234ポイント」からカンマを除去して数値を抽出
      const text = el.textContent.replace(/[,、]/g, "");
      const match = text.match(/(\d+)\s*ポイント/);
      if (match) return parseInt(match[1], 10);

      // 「ポイント」表記がない場合も数字だけで試みる
      const numMatch = text.match(/\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0], 10);
        // ポイント数として妥当な範囲（1〜100万）
        if (num > 0 && num < 1000000) return num;
      }
    }
  }

  // --- 3. クラス名に point または deal を含む要素から正規表現で抽出 ---
  const candidateElements = doc.querySelectorAll(
    "[class*='point'], [class*='Point'], [class*='deal'], [class*='Deal']"
  );
  for (const el of candidateElements) {
    if (el.children.length === 0 || (el.children.length === 1 && el.querySelector("span"))) {
      const text = el.textContent.replace(/[,、]/g, "").trim();
      const match = text.match(/^(\d+)\s*ポイント/);
      if (match) {
        const val = parseInt(match[1], 10);
        if (val > 0 && val < 1000000) {
          console.log("ResearchDeck: クラス名部分一致からポイントを検出しました:", val);
          return val;
        }
      }
    }
  }

  // --- 4. フォールバック: ページ全文からポイント表記を検索 ---
  const bodyText = doc.body ? doc.body.textContent.replace(/[,、]/g, "") : "";
  const pointPatterns = [
    /獲得予定ポイント[\s:：]*(\d+)/,
    /(\d+)\s*ポイント(?:獲得|進呈|付与)/,
    /(\d+)\s*ポイント\s*(?:内訳|[\(（])/ // "582ポイント 内訳" などに対応
  ];

  for (const pattern of pointPatterns) {
    const match = bodyText.match(pattern);
    if (match) return parseInt(match[1], 10);
  }

  return 0;
}

/**
 * クーポン割引金額を抽出する
 * 「〇〇円OFFクーポン」などの表記から金額を取得
 * @returns {number} クーポン金額の合計。取得できない場合は0
 */
/**
 * 要素がヘッダー、フッター、サイドバーなどのショップ共通広告・ナビゲーション領域にあるか判定する
 */
function isInExcludedArea(el) {
  const excludedSelectors = [
    // 楽天全体の共通ヘッダー・フッター（共通の200円エントリーキャンペーン等がある場所）
    "#commonHeader",
    "#commonFooter",
    "#grHeader",
    "#grFooter",
    "#partsHeader",
    "#partsFooter",
    // ショップ独自のメインヘッダー看板エリア（共通の200円バナー看板がある場所）
    ".shop-header",
    ".shopHeader",
    "#shopHeader",
    "#shopheader",
    // おすすめ商品（広告）などの他商品用エリア
    ".recommend",
    ".recommendation",
    "[class*='recommend']",
    "[id*='recommend']",
    // 左メニュー（共通ナビゲーション等）
    ".left-column",
    "#left-column"
  ];

  for (const selector of excludedSelectors) {
    try {
      if (el.closest(selector)) {
        return true;
      }
    } catch (e) {
      // セレクタエラーは無視
    }
  }
  return false;
}

function extractCoupon(doc = document) {
  // --- クーポン表示エリアのセレクタ候補（部分一致セレクタも含め広範にスキャン） ---
  const couponSelectors = [
    ".coupon-area",
    ".coupon",
    "[class*='coupon']",
    "[class*='Coupon']",
    "[class*='rcp-']",
    "[class*='RaCoupon']",
    "[id*='rcp-']",
    "[id*='RaCoupon']",
    "[data-coupon-id]",
    ".rakutenLimitedId_Coupon",
    ".item-coupon",
    "#coupon",
    ".shop-coupon",
    ".coupon-badge",
  ];

  const couponValues = [];

  // --- 1. クーポン表示要素からの抽出 ---
  for (const selector of couponSelectors) {
    const elements = doc.querySelectorAll(selector);
    for (const el of elements) {
      // ショップ共通エリア（ヘッダー/フッター/サイドバーなど）にある広告や共通メニューは除外する
      if (isInExcludedArea(el)) continue;

      const text = el.textContent.replace(/[,、]/g, "");
      const matches = text.matchAll(/(\d+)\s*円\s*(?:OFF|off|オフ|引|クーポン|割引)/gi);
      for (const match of matches) {
        const val = parseInt(match[1], 10);
        if (val > 0) {
          couponValues.push(val);
        }
      }
    }
  }

  // --- 2. メインボディ領域（#pagebody等）のテキスト全体からの抽出 ---
  const mainBody = doc.querySelector("#pagebody, #rakutenLimitedId_aroundCart, [class*='purchaseBox'], [class*='purchase-box']");
  if (mainBody) {
    const textToSearch = mainBody.textContent.replace(/[,、]/g, "");
    const couponPatterns = [
      /(\d+)\s*円\s*(?:OFF|off|オフ|引|クーポン|割引)/gi,
      /クーポン[\s:：]*(\d+)\s*円/gi,
    ];

    for (const pattern of couponPatterns) {
      const matches = textToSearch.matchAll(pattern);
      for (const match of matches) {
        const val = parseInt(match[1], 10);
        if (val > 0) {
          couponValues.push(val);
        }
      }
    }
  }

  // --- 3. 最終フォールバック：共通エリアを除去した body 全体のテキストからの抽出 ---
  if (doc.body) {
    const clone = doc.body.cloneNode(true);
    // 楽天共通ヘッダー・フッターおよびショップ看板のみを除外
    const excludedEls = clone.querySelectorAll("#commonHeader, #commonFooter, #grHeader, #grFooter, #partsHeader, #partsFooter, .shop-header, .shopHeader");
    excludedEls.forEach(el => el.remove());
    const bodyText = clone.textContent.replace(/[,、]/g, "");

    const fallbackPatterns = [
      /(\d+)\s*円\s*(?:OFF|off|オフ|引|クーポン|割引)/gi,
      /クーポン[\s:：]*(\d+)\s*円/gi,
    ];

    for (const pattern of fallbackPatterns) {
      const matches = bodyText.matchAll(pattern);
      for (const match of matches) {
        const val = parseInt(match[1], 10);
        if (val > 0) {
          couponValues.push(val);
        }
      }
    }
  }

  // 検出されたクーポン額の中で「最大値」を採用する
  if (couponValues.length > 0) {
    const maxCoupon = Math.max(...couponValues);
    console.log("ResearchDeck: 検出されたクーポン候補:", couponValues, "-> 採用値(最大値):", maxCoupon);
    return maxCoupon;
  }

  return 0;
}

// ============================================================
// 2. 実質仕入れ値の計算
// ============================================================

/**
 * 実質仕入れ値を計算する
 * 実質仕入れ値 = 商品価格 - 獲得ポイント - クーポン金額
 * @param {number} price - 商品価格（税込）
 * @param {number} points - 獲得予定ポイント
 * @param {number} coupon - クーポン割引金額
 * @returns {number} 実質仕入れ値
 */
function calculateNetCost(price, points, coupon) {
  return price - points - coupon;
}

// ============================================================
// 3. 利益計算
// ============================================================

/**
 * 利益を計算する
 * 粗利益 = Amazon販売価格 - FBA手数料合計 - 実質仕入れ値
 *
 * @param {number} amazonPrice - Amazon販売価格
 * @param {number} totalFees - FBA手数料合計
 * @param {number} netCost - 実質仕入れ値
 * @returns {Object} { profit, profitRate }
 */
function calculateProfit(amazonPrice, totalFees, netCost) {
  if (!amazonPrice || amazonPrice <= 0) {
    return { profit: null, profitRate: null };
  }

  const profit = amazonPrice - totalFees - netCost;
  const profitRate = (profit / amazonPrice) * 100;

  return {
    profit: Math.round(profit),
    profitRate: Math.round(profitRate * 10) / 10, // 小数第1位まで
  };
}

// ============================================================
// 4. UIの描画（ダッシュボードモーダル）
// ============================================================

/**
 * FBA月間保管手数料の計算内訳からツールチップに表示するテキストを生成する
 * @param {Object} details - 保管料の内訳オブジェクト
 * @returns {string} ツールチップ用テキスト
 */
function generateStorageFeeTooltipText(details) {
  if (!details) return "";
  
  const sizeType = details.isStandardSize ? "標準サイズ" : "大型サイズ";
  const apparelText = details.isApparel ? " (アパレル判定)" : "";
  const seasonText = details.isQ4 ? "繁忙期 (10-12月)" : "通常期 (1-9月)";
  
  return `サイズ区分: ${sizeType}${apparelText}\n` +
         `梱包寸法: ${details.longestSide} × ${details.medianSide} × ${details.shortestSide} cm\n` +
         `重量: ${details.weight} kg\n` +
         `算出体積: ${formatNumber(details.volume)} cm³\n` +
         `基準単価: ${details.baseRate.toFixed(3)}円 / 1,000cm³\n` +
         `適用時期: ${seasonText}\n` +
         `計算式: ${details.baseRate.toFixed(3)}円 × (${formatNumber(details.volume)} / 1,000)`;
}

/**
 * 数値を3桁ごとにカンマ区切りでフォーマットする
 * 例: 12345 → "12,345"
 * @param {number|null} num - フォーマットする数値
 * @returns {string} フォーマットされた文字列
 */
function formatNumber(num) {
  if (num === null || num === undefined) return "---";
  return num.toLocaleString("ja-JP");
}

/**
 * 消費税を除いた税抜価格を計算する
 * 食品・飲料の場合は8%軽減税率、その他は10%標準税率で逆算
 * @param {number} price - 税込価格
 * @param {string} categoryName - カテゴリ名
 * @returns {number} 税抜価格
 */
function calculateTaxExcludedPrice(price, categoryName) {
  if (!price || price <= 0) return 0;

  // 食品・飲料系カテゴリの判定キーワード
  const isFoodOrBeverage = categoryName && 
    (categoryName.includes("食品") || 
     categoryName.includes("飲料") || 
     categoryName.includes("お酒") || 
     categoryName.includes("Grocery") || 
     categoryName.includes("食品・飲料・お酒"));
  
  const taxRate = isFoodOrBeverage ? 0.08 : 0.10;
  return Math.floor(price / (1 + taxRate));
}

/**
 * 出品ステータスのバッジHTMLを生成する
 * 申請が必要な場合は申請ページへのリンクボタンにする
 * @param {Object|null} amazonData - SP-APIから取得したAmazonデータ
 * @returns {string} バッジのHTML文字列
 */
function getListingStatusBadge(amazonData) {
  if (!amazonData) return "";

  const link = amazonData.approvalLink;

  if (amazonData.canSell === true) {
    return `<span class="rd-badge rd-badge-ok">✅ 出品可能</span>`;
  } else if (amazonData.requiresApproval === true) {
    if (link) {
      return `<a href="${link}" target="_blank" class="rd-badge rd-badge-warn" title="クリックして出品申請ページを開く（外部サイト）">⚠️ 要申請 (申請する ↗)</a>`;
    } else {
      return `<span class="rd-badge rd-badge-warn">⚠️ 要申請</span>`;
    }
  } else if (amazonData.canSell === false) {
    return `<span class="rd-badge rd-badge-ng">❌ 出品不可</span>`;
  }

  return `<span class="rd-badge rd-badge-unknown">― 不明</span>`;
}

/**
 * ResearchDeckのダッシュボードUIを生成してページに挿入する
 * SP-API未設定時は楽天データのみ表示
 * SP-API設定済みの場合はAmazonセクション（利益・出品可否・販売数）も表示
 *
 * @param {Object} rakutenData - 楽天から抽出したデータ
 * @param {Object|null} amazonData - SP-APIから取得したデータ（nullの場合あり）
 */
function renderDashboard(rakutenData, amazonData) {
  // 既存のダッシュボードがあれば削除（再実行対策）
  const existing = document.getElementById("rd-dashboard");
  if (existing) existing.remove();

  // ダッシュボード全体のコンテナを作成
  const dashboard = document.createElement("div");
  dashboard.id = "rd-dashboard";

  // --- Amazonセクションの構築（SP-APIデータがある場合のみ） ---
  let amazonSectionHtml = "";

  if (amazonData) {
    // 利益計算
    const profitData = calculateProfit(
      amazonData.amazonPrice,
      amazonData.totalFees,
      rakutenData.netCost
    );

    // 利益額の色分け（黒字=グリーン、赤字=レッド）
    const profitClass = profitData.profit !== null
      ? (profitData.profit >= 0 ? "rd-profit-positive" : "rd-profit-negative")
      : "";

    // 利益率の色分け
    const profitRateClass = profitData.profitRate !== null
      ? (profitData.profitRate >= 0 ? "rd-profit-positive" : "rd-profit-negative")
      : "";

    // エラーメッセージ（APIからの価格取得エラーなども表示する）
    const amazonErrorHtml = (amazonData.error || amazonData.pricingError)
      ? `<div class="rd-alert rd-alert-info" style="margin-top: 8px; border-color: #f0ddb8; background-color: #fdf5e6; color: #8b6914;">
           <span class="rd-alert-icon">⚠️</span>
           <span>${amazonData.error === "PRODUCT_NOT_FOUND"
             ? "Amazon上に該当商品が見つかりませんでした"
             : `価格取得エラー: ${amazonData.error || amazonData.pricingError}`}</span>
         </div>`
      : "";

    // 出品制限の理由（ある場合）
    const restrictionReasonsHtml = (amazonData.restrictionReasons && amazonData.restrictionReasons.length > 0)
      ? `<div class="rd-restriction-reasons" style="margin-top: 4px;">
           ${amazonData.restrictionReasons.map(r => `<span class="rd-restriction-reason">${r}</span>`).join("")}
         </div>`
      : "";

    amazonSectionHtml = `
      <!-- 出品ステータスセクション（コンパクト版、一番上に配置） -->
      <div class="rd-section" style="margin-bottom: 12px;">
        <div class="rd-status-compact" style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="rd-section-dot rd-dot-listing"></span>
            <span class="rd-section-title" style="margin-bottom: 0;">出品ステータス</span>
          </div>
          ${getListingStatusBadge(amazonData)}
        </div>
        ${restrictionReasonsHtml}
      </div>

      <!-- 利益計算セクション -->
      <div class="rd-section">
        <div class="rd-section-header">
          <span class="rd-section-dot rd-dot-profit"></span>
          <span class="rd-section-title">利益計算</span>
        </div>
        ${amazonErrorHtml}
        <div class="rd-data-grid">
          <div class="rd-data-row">
            <span class="rd-data-label">Amazon価格</span>
            <span class="rd-data-value">
              ${amazonData.amazonPrice 
                ? `¥${formatNumber(amazonData.amazonPrice)}` 
                : (amazonData.pricingError 
                    ? `<span style="color: #b44a3a; font-size: 11px; font-weight: normal;" title="${amazonData.pricingError}">取得エラー ⚠️</span>` 
                    : "---")}
            </span>
          </div>
          <div class="rd-data-row">
            <span class="rd-data-label">販売手数料</span>
            <span class="rd-data-value rd-text-fee">-¥${formatNumber(amazonData.referralFee || 0)}</span>
          </div>
          <div class="rd-data-row">
            <span class="rd-data-label">FBA配送手数料</span>
            <span class="rd-data-value rd-text-fee">-¥${formatNumber(amazonData.fbaFulfillmentFee || 0)}</span>
          </div>
          <div class="rd-data-row">
            <span class="rd-data-label">月間保管手数料 (1ヶ月)</span>
            <span class="rd-data-value rd-text-fee ${amazonData.monthlyStorageFeeDetails ? 'rd-tooltip' : ''}" ${amazonData.monthlyStorageFeeDetails ? `data-tooltip="${generateStorageFeeTooltipText(amazonData.monthlyStorageFeeDetails)}"` : ''}>-¥${formatNumber(amazonData.monthlyStorageFee || 0)}</span>
          </div>
          <div class="rd-data-row">
            <span class="rd-data-label">実質仕入れ値</span>
            <span class="rd-data-value rd-text-fee" id="rd-amazon-net-cost">-¥${formatNumber(rakutenData.netCost)}</span>
          </div>
          <div class="rd-divider"></div>
          <div class="rd-data-row rd-highlight-row">
            <span class="rd-data-label rd-text-bold">粗利益</span>
            <span class="rd-data-value rd-profit-value ${profitClass}" id="rd-amazon-profit">${profitData.profit !== null ? `¥${formatNumber(profitData.profit)}` : "---"}</span>
          </div>
          <div class="rd-data-row">
            <span class="rd-data-label">利益率</span>
            <span class="rd-data-value ${profitRateClass}" id="rd-amazon-profit-rate">${profitData.profitRate !== null ? `${profitData.profitRate}%` : "---"}</span>
          </div>

        </div>
      </div>

      <!-- 市場データセクション -->
      <div class="rd-section">
        <div class="rd-section-header">
          <span class="rd-section-dot rd-dot-market"></span>
          <span class="rd-section-title">市場データ</span>
        </div>
        <div class="rd-data-grid">
          <div class="rd-data-row">
            <span class="rd-data-label">カテゴリ</span>
            <span class="rd-data-value rd-text-small">${amazonData.categoryName || "---"}</span>
          </div>
          <div class="rd-data-row">
            <span class="rd-data-label">ランキング</span>
            <span class="rd-data-value">${amazonData.salesRank ? `#${formatNumber(amazonData.salesRank)}` : "---"}</span>
          </div>
          <div class="rd-data-row">
            <span class="rd-data-label">出品者数 (新品)</span>
            <span class="rd-data-value">${amazonData.numberOfNewOffers !== null && amazonData.numberOfNewOffers !== undefined ? `${amazonData.numberOfNewOffers}人` : "---"}</span>
          </div>
          <div class="rd-data-row">
            <span class="rd-data-label">月間推定販売数</span>
            <span class="rd-data-value rd-text-emphasis">
              ${(amazonData.estimatedMonthlySales !== null && amazonData.estimatedMonthlySales !== undefined) ? `約${formatNumber(amazonData.estimatedMonthlySales)}個` : "---"}
              ${amazonData.hasVariations ? `<span class="rd-tooltip" data-tooltip="Amazonで複数のバリエーションが存在する商品です。\n表示されている推定販売数は、ページ全体の全バリエーション合算値の可能性があります。" style="color: #ef6c00; font-size: 11px; margin-left: 4px; cursor: help; vertical-align: middle;">⚠️</span>` : ""}
            </span>
          </div>
          ${amazonData.salesEstimateConfidence ? `
          <div class="rd-data-row">
            <span class="rd-data-label">推定精度</span>
            <span class="rd-data-value rd-text-muted">${amazonData.salesEstimateConfidence}</span>
          </div>
          ` : ""}
        </div>
      </div>
    `;
  }

  // --- ダッシュボードのHTML構造 ---
  dashboard.innerHTML = `
    <div class="rd-header">
      <div class="rd-logo">
        <span class="rd-logo-icon">◈</span>
        <span class="rd-logo-text">ResearchDeck</span>
      </div>
      <div class="rd-header-actions">
        <button class="rd-icon-btn" id="rd-refresh-btn" title="最新情報に更新（JAN未取得時の再読み込み）">🔄</button>
        <button class="rd-icon-btn" id="rd-settings-btn" title="設定を開く">⚙️</button>
        <button class="rd-close" id="rd-close-btn" aria-label="閉じる">×</button>
      </div>
    </div>

    <div class="rd-body">
      <!-- 識別子セクション（JAN / ASIN） -->
      <div class="rd-identifier-section">
        <div class="rd-identifier-row">
          <span class="rd-identifier-label">JAN</span>
          <span class="rd-identifier-value" id="rd-copy-jan" title="クリックでコピー" data-copy="${rakutenData.janCode || ''}">
            ${rakutenData.janCode || '<span style="color: #b44a3a; font-size: 9.5px; font-family: inherit; font-weight: 700; white-space: nowrap;" title="JANコードが見つかりませんでした。ページ読み込み完了後に、右上の更新ボタン（🔄）を押して再取得してください。">⚠️ 未検出 (🔄更新)</span>'}
            ${rakutenData.janCode ? `<span class="rd-copy-icon">${COPY_ICON_SVG}</span>` : ''}
          </span>
          <div class="rd-identifier-buttons">
            ${rakutenData.janCode ? `
              <a href="https://search.rakuten.co.jp/search/mall/${rakutenData.janCode}/" target="_blank" rel="noopener noreferrer" class="rd-link-btn rd-link-btn-rakuten" title="楽天市場でJAN検索">楽天 ↗</a>
              <a href="https://shopping.yahoo.co.jp/search?p=${rakutenData.janCode}" target="_blank" rel="noopener noreferrer" class="rd-link-btn rd-link-btn-yahoo" title="Yahoo!ショッピングでJAN検索">ヤフ ↗</a>
            ` : ''}
          </div>
        </div>
        <div class="rd-identifier-row">
          <span class="rd-identifier-label">ASIN</span>
          <span class="rd-identifier-value" id="rd-copy-asin" title="クリックでコピー" data-copy="${(amazonData && amazonData.asin) ? amazonData.asin : ''}">
            ${(amazonData && amazonData.asin) ? amazonData.asin : "---"}
            ${(amazonData && amazonData.asin) ? `<span class="rd-copy-icon">${COPY_ICON_SVG}</span>` : ''}
          </span>
          <div class="rd-identifier-buttons">
            ${(amazonData && amazonData.asin) ? `
              <a href="https://www.amazon.co.jp/dp/${amazonData.asin}" target="_blank" rel="noopener noreferrer" class="rd-link-btn rd-link-btn-amazon" title="Amazonの商品ページを開く">Amazon ↗</a>
              <a href="https://sellercentral.amazon.co.jp/revcal?asin=${amazonData.asin}" target="_blank" rel="noopener noreferrer" class="rd-link-btn rd-link-btn-sim" title="FBA料金シミュレーターを一発で起動する">シミュ ↗</a>
            ` : ''}
          </div>
        </div>
      </div>

      <!-- 楽天セクション -->
      <div class="rd-section">
        <div class="rd-section-header">
          <span class="rd-section-dot rd-dot-rakuten"></span>
          <span class="rd-section-title">楽天市場</span>
        </div>
        <div class="rd-data-grid">
          <div class="rd-data-row">
            <span class="rd-data-label">価格（税込）</span>
            <span class="rd-data-value">¥${formatNumber(rakutenData.price)}</span>
          </div>
          <div class="rd-data-row">
            <span class="rd-data-label">獲得ポイント</span>
            <span class="rd-data-value rd-text-accent">${formatNumber(Math.abs(rakutenData.points))}pt</span>
          </div>
          <div class="rd-data-row" style="flex-wrap: wrap;">
            <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
              <span class="rd-data-label">追加ポイント (%)</span>
              <span class="rd-data-value" style="display: flex; align-items: center; gap: 4px;">
                <input type="number" id="rd-input-extra-point" min="0" max="100" step="1" value="${rakutenData.extraPointRate || 0}" class="rd-number-input" title="ポイント付与対象である「税抜価格」を基準に計算します" />
                <span>%</span>
              </span>
            </div>
            <div style="width: 100%; text-align: right; margin-top: 2px;">
              <span id="rd-tax-excluded-info" style="font-size: 10px; color: #b0aaa3;">(税抜価格 ¥${formatNumber(rakutenData.taxExcludedPrice)} に対して : <span id="rd-extra-points-display" style="color: #6b7f94; font-weight: 700;">${formatNumber(Math.abs(rakutenData.extraPoints || 0))}</span>pt)</span>
            </div>
          </div>
          <div class="rd-data-row">
            <span class="rd-data-label">クーポン (¥)</span>
            <span class="rd-data-value rd-text-accent" style="display: flex; align-items: center; gap: 4px;">
              <span>-¥</span>
              <input type="number" id="rd-input-coupon" min="0" step="100" value="${rakutenData.coupon || 0}" class="rd-number-input" style="width: 70px;" title="クーポン割引金額を手動で調整できます" />
            </span>
          </div>
          <div class="rd-divider"></div>
          <div class="rd-data-row rd-highlight-row">
            <span class="rd-data-label rd-text-bold">実質仕入れ値</span>
            <span class="rd-data-value rd-net-cost" id="rd-rakuten-net-cost">¥${formatNumber(rakutenData.netCost)}</span>
          </div>
        </div>
      </div>

      ${amazonSectionHtml}
    </div>
  `;

  document.body.appendChild(dashboard);

  // ローカルストレージから前回ドラッグしたダッシュボードの位置情報を復元する
  const savedTop = localStorage.getItem("rd-dashboard-top");
  const savedLeft = localStorage.getItem("rd-dashboard-left");
  if (savedTop !== null && savedLeft !== null) {
    dashboard.style.top = savedTop;
    dashboard.style.left = savedLeft;
    dashboard.style.right = "auto"; // CSSの right: 16px 指定を無効化して left指定を効かせる
  }

  const refreshBtn = document.getElementById("rd-refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      const newRakutenData = extractRakutenData();
      const savedExtraRate = parseInt(localStorage.getItem("rd-extra-point-rate"), 10) || 0;
      newRakutenData.extraPointRate = savedExtraRate;
      const pageTitle = document.title || "";
      const isLikelyFood = /お茶|水|炭酸|飲料|食品|グルメ|スイーツ|ビール|酒/i.test(pageTitle);
      const initialTaxRate = isLikelyFood ? 0.08 : 0.10;
      newRakutenData.taxExcludedPrice = Math.floor(newRakutenData.price / (1 + initialTaxRate));
      const extraPoints = Math.floor(newRakutenData.taxExcludedPrice * (savedExtraRate / 100));
      newRakutenData.extraPoints = Math.abs(extraPoints);
      newRakutenData.netCost = newRakutenData.price - Math.abs(newRakutenData.points) - Math.abs(extraPoints) - newRakutenData.coupon;
      if (newRakutenData.janCode) {
        await fetchAndRenderAmazonData(newRakutenData);
      } else {
        renderDashboard(newRakutenData, null);
      }
    });
  }

  const settingsBtn = document.getElementById("rd-settings-btn");
  if (settingsBtn) {
    settingsBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_OPTIONS_PAGE" });
    });
  }

  const closeBtn = document.getElementById("rd-close-btn");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      dashboard.classList.add("rd-hidden");
    });
  }

  setupCopyClick("rd-copy-jan");
  setupCopyClick("rd-copy-asin");

  const header = dashboard.querySelector(".rd-header");
  if (header) {
    makeElementDraggable(dashboard, header);
  }

  const extraPointInput = document.getElementById("rd-input-extra-point");
  const couponInput = document.getElementById("rd-input-coupon");

  function updateCalculations() {
    const extraPointRate = parseInt(extraPointInput?.value || 0, 10);
    const couponValue = parseInt(couponInput?.value || 0, 10);
    localStorage.setItem("rd-extra-point-rate", extraPointRate);
    const extraPoints = Math.floor(rakutenData.taxExcludedPrice * (extraPointRate / 100));
    const extraPointsDisplayEl = document.getElementById("rd-extra-points-display");
    if (extraPointsDisplayEl) extraPointsDisplayEl.textContent = `${formatNumber(Math.abs(extraPoints))}`;
    const netCost = rakutenData.price - rakutenData.points - Math.abs(extraPoints) - couponValue;
    const rakutenNetCostEl = document.getElementById("rd-rakuten-net-cost");
    if (rakutenNetCostEl) rakutenNetCostEl.textContent = `¥${formatNumber(netCost)}`;
    const amazonNetCostEl = document.getElementById("rd-amazon-net-cost");
    if (amazonNetCostEl) amazonNetCostEl.textContent = `-¥${formatNumber(netCost)}`;
    if (amazonData && amazonData.amazonPrice) {
      const profitData = calculateProfit(amazonData.amazonPrice, amazonData.totalFees, netCost);
      const profitEl = document.getElementById("rd-amazon-profit");
      if (profitEl) {
        profitEl.textContent = profitData.profit !== null ? `¥${formatNumber(profitData.profit)}` : "---";
        profitEl.className = "rd-data-value rd-profit-value " + (profitData.profit !== null ? (profitData.profit >= 0 ? "rd-profit-positive" : "rd-profit-negative") : "");
      }
      const profitRateEl = document.getElementById("rd-amazon-profit-rate");
      if (profitRateEl) {
        profitRateEl.textContent = profitData.profitRate !== null ? `${profitData.profitRate}%` : "---";
        profitRateEl.className = "rd-data-value " + (profitData.profitRate !== null ? (profitData.profitRate >= 0 ? "rd-profit-positive" : "rd-profit-negative") : "");
      }
    }
  }

  if (extraPointInput) extraPointInput.addEventListener("input", updateCalculations);
  if (couponInput) couponInput.addEventListener("input", updateCalculations);
}

function setupCopyClick(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.addEventListener("click", async () => {
    const textToCopy = el.getAttribute("data-copy");
    if (!textToCopy) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
      const originalHTML = el.innerHTML;
      el.innerHTML = `コピー済 ✓`;
      el.style.color = "#2e7d32";
      setTimeout(() => { el.innerHTML = originalHTML; el.style.color = ""; }, 1500);
    } catch (err) { console.error("ResearchDeck: コピー失敗", err); }
  });
}

function makeElementDraggable(element, handle) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  handle.onmousedown = (e) => {
    e.preventDefault();
    pos3 = e.clientX; pos4 = e.clientY;
    document.onmouseup = () => {
      document.onmouseup = null;
      document.onmousemove = null;
      // ドラッグ終了時に、ダッシュボードの位置情報をローカルストレージに記憶する
      localStorage.setItem("rd-dashboard-top", element.style.top);
      localStorage.setItem("rd-dashboard-left", element.style.left);
    };
    document.onmousemove = (e) => {
      pos1 = pos3 - e.clientX; pos2 = pos4 - e.clientY;
      pos3 = e.clientX; pos4 = e.clientY;
      element.style.top = (element.offsetTop - pos2) + "px";
      element.style.left = (element.offsetLeft - pos1) + "px";
    };
  };
}

function showAmazonLoading() {
  const body = document.querySelector("#rd-dashboard .rd-body");
  if (!body) return;
  const loading = document.createElement("div");
  loading.id = "rd-amazon-loading";
  loading.className = "rd-section";
  loading.innerHTML = `<div class="rd-section-header"><span class="rd-section-dot rd-dot-profit"></span><span class="rd-section-title">Amazon データ</span></div><div class="rd-loading"><span class="rd-loading-spinner"></span><span>SP-API からデータを取得中...</span></div>`;
  body.appendChild(loading);
}

function removeAmazonLoading() {
  const loading = document.getElementById("rd-amazon-loading");
  if (loading) loading.remove();
}

function extractRakutenData(doc = document) {
  let janCode = null;
  let price = 0;
  let points = 0;
  let coupon = 0;

  // --- 1. JSON-LD (構造化データ) からの抽出を最優先とする ---
  const jsonLdData = extractFromJsonLd(doc);
  if (jsonLdData) {
    if (jsonLdData.jan) janCode = jsonLdData.jan;
    if (jsonLdData.price) price = jsonLdData.price;
  }

  // --- 2. script#item-page-app-data (JSON) からの抽出を試みる ---
  if (!janCode || price === 0) {
    const appDataEl = doc.getElementById("item-page-app-data");
    if (appDataEl) {
      try {
        const rootData = JSON.parse(appDataEl.textContent);
        const item = rootData.newApi && rootData.newApi.itemInfoSku;
        if (item) {
          // JANコードの特定
          if (!janCode && item.sku && item.sku.length > 0) {
            const firstJanSku = item.sku.find(s => s.articleNumber && s.articleNumber.value);
            if (firstJanSku) {
              janCode = firstJanSku.articleNumber.value;
            }
          }
          // 価格の特定
          if (price === 0 && item.sku && item.sku.length > 0) {
            price = item.sku[0].taxIncludedPrice || 0;
          }
          
          // ポイント倍率から獲得予定ポイントを概算
          if (price > 0 && points === 0) {
            let pointRate = 1;
            if (item.newShopPoints && item.newShopPoints[0] && item.newShopPoints[0].all) {
              pointRate = item.newShopPoints[0].all;
            }
            points = Math.floor(price * (pointRate / 100));
          }
        }
      } catch (e) {
        console.warn("ResearchDeck: item-page-app-dataのパースに失敗しました", e);
      }
    }
  }

  // --- 3. DOMからのフォールバック抽出 ---
  if (!janCode) {
    janCode = extractJanCode(doc);
  }
  
  if (price === 0) {
    price = extractPrice(doc);
  }

  // ポイントは「SPU等を含むユーザーの実際の保有ポイント」がDOMに表示されていればそれを優先
  const domPoints = extractPoints(doc);
  if (domPoints > 0) {
    points = domPoints;
  } else if (points === 0 && price > 0) {
    // 最終フォールバックとして 1% を仮定
    points = Math.floor(price * 0.01);
  }

  // クーポンもDOMから抽出
  coupon = extractCoupon(doc);

  // 獲得ポイント値のマイナスやプラス符号の混入を防ぐため、常に絶対値にする
  const absolutePoints = Math.abs(points);

  return {
    janCode,
    price,
    points: absolutePoints,
    coupon,
    netCost: price - absolutePoints - coupon
  };
}

/**
 * SP-APIからAmazonデータを非同期で取得し、ダッシュボードを更新・再描画する
 */
async function fetchAndRenderAmazonData(rakutenData) {
  showAmazonLoading();
  try {
    const result = await chrome.runtime.sendMessage({
      type: "FETCH_AMAZON_DATA",
      janCode: rakutenData.janCode,
    });
    
    removeAmazonLoading();
    
    if (result && result.success && result.data) {
      // 食品判定などの税率自動計算のため、税抜価格を再計算
      rakutenData.taxExcludedPrice = calculateTaxExcludedPrice(rakutenData.price, result.data.categoryName);
      
      // 追加ポイント
      const savedExtraRate = parseInt(localStorage.getItem("rd-extra-point-rate"), 10) || 0;
      rakutenData.extraPointRate = savedExtraRate;
      const extraPoints = Math.floor(rakutenData.taxExcludedPrice * (savedExtraRate / 100));
      rakutenData.extraPoints = Math.abs(extraPoints);
      rakutenData.netCost = rakutenData.price - Math.abs(rakutenData.points) - Math.abs(extraPoints) - rakutenData.coupon;
      
      currentAmazonData = result.data;
      renderDashboard(rakutenData, result.data);
    } else {
      console.warn("ResearchDeck: Amazonデータの取得に失敗しました。楽天データのみで描画します。", result ? result.error : "");
      const errorData = {
        error: result ? result.error : "通信エラー",
        pricingError: result ? result.pricingError : null,
        amazonPrice: null,
        referralFee: 0,
        fbaFulfillmentFee: 0,
        monthlyStorageFee: 0,
        totalFees: 0,
        canSell: null,
        requiresApproval: false,
        restrictionReasons: [],
        salesRank: null,
        estimatedMonthlySales: null,
        categoryName: null,
      };
      currentAmazonData = errorData;
      renderDashboard(rakutenData, errorData);
    }
  } catch (err) {
    console.error("ResearchDeck: Amazonデータ取得中に例外が発生しました", err);
    removeAmazonLoading();
    const exceptionData = {
      error: err.message || "予期しない通信エラー",
      amazonPrice: null,
      referralFee: 0,
      fbaFulfillmentFee: 0,
      monthlyStorageFee: 0,
      totalFees: 0,
      canSell: null,
      requiresApproval: false,
      restrictionReasons: [],
      salesRank: null,
      estimatedMonthlySales: null,
      categoryName: null,
    };
    currentAmazonData = exceptionData;
    renderDashboard(rakutenData, exceptionData);
  }
}

/**
 * 詳細ページでの統合初期化処理
 */
async function initializeDetailPage() {
  console.log("ResearchDeck: 詳細ページの初期化を開始します...");

  // --- ステップ1: 楽天ページからデータを抽出 ---
  const rakutenData = extractRakutenData();
  
  // 保存された追加ポイント倍率を復元して初期値として適用する
  const savedExtraRate = parseInt(localStorage.getItem("rd-extra-point-rate"), 10) || 0;
  rakutenData.extraPointRate = savedExtraRate;
  
  // 税抜価格の計算（初期はカテゴリ名がわからないため、タイトルキーワードで簡易食品判定）
  const pageTitle = document.title || "";
  const isLikelyFood = /お茶|水|炭酸|飲料|食品|グルメ|スイーツ|ビール|酒/i.test(pageTitle);
  const initialTaxRate = isLikelyFood ? 0.08 : 0.10;
  rakutenData.taxExcludedPrice = Math.floor(rakutenData.price / (1 + initialTaxRate));

  const extraPoints = Math.floor(rakutenData.taxExcludedPrice * (savedExtraRate / 100));
  // 常に絶対値で保持し、符号の混入を防止する
  rakutenData.extraPoints = Math.abs(extraPoints);
  rakutenData.netCost = rakutenData.price - Math.abs(rakutenData.points) - Math.abs(extraPoints) - rakutenData.coupon;

  console.log("ResearchDeck: 抽出結果", rakutenData);

  // 初期の自動取得値（クーポンなど）を記憶
  currentAutoCoupon = rakutenData.coupon;
  currentAutoExtraRate = savedExtraRate;
  currentAmazonData = null;

  // --- ステップ2: まず楽天データのみでダッシュボードを表示 ---
  renderDashboard(rakutenData, null);

  // --- ステップ3: JANコードが正しく取得されている場合は即座にデータ取得へ ---
  if (rakutenData.janCode && isValidJanCode(rakutenData.janCode)) {
    await fetchAndRenderAmazonData(rakutenData);
  } else {
    console.log("ResearchDeck: 正しいJANコードが検出されませんでした。ページ読み込み完了後に手動更新ボタン（🔄）を押して再読み込みしてください。");
    // 不正または未取得のJANは一旦クリアして描画する
    rakutenData.janCode = null;
    renderDashboard(rakutenData, null);
  }

  // --- ステップ4: 非同期で遅れてロードされるクーポンやJANコードを救済する自動ポーリング ---
  const pollIntervals = [1500, 3000, 5000, 10000];
  pollIntervals.forEach(delay => {
    setTimeout(async () => {
      console.log(`ResearchDeck: バックグラウンド自動再スキャンを実行します (${delay}ms)...`);
      const newData = extractRakutenData();
      let updated = false;

      // 1. クーポン更新の確認
      const couponInput = document.getElementById("rd-input-coupon");
      const currentCouponVal = couponInput ? parseInt(couponInput.value || 0, 10) : rakutenData.coupon;
      // ユーザーが手動編集していない（＝現在の入力値が前回自動取得した値と等しい）場合で、新しいクーポン値が異なる場合
      if (newData.coupon !== currentAutoCoupon && currentCouponVal === currentAutoCoupon) {
        console.log(`ResearchDeck: クーポン値が更新されました: ${currentAutoCoupon} -> ${newData.coupon}`);
        rakutenData.coupon = newData.coupon;
        currentAutoCoupon = newData.coupon;
        updated = true;
      }

      // 2. JANコードの更新確認（初期ロードで取得できず、後からDOMにロードされた場合）
      if (!rakutenData.janCode && newData.janCode && isValidJanCode(newData.janCode)) {
        console.log(`ResearchDeck: JANコードが新しく検出されました: ${newData.janCode}`);
        rakutenData.janCode = newData.janCode;
        updated = true;
      }

      // 3. 価格の更新確認（初期値が0で、後からDOMにロードされた場合）
      if (rakutenData.price === 0 && newData.price > 0) {
        console.log(`ResearchDeck: 価格が新しく検出されました: ${newData.price}`);
        rakutenData.price = newData.price;
        rakutenData.points = newData.points || Math.floor(newData.price * 0.01);
        
        // 税抜価格を再計算
        const pageTitle = document.title || "";
        const isLikelyFood = /お茶|水|炭酸|飲料|食品|グルメ|スイーツ|ビール|酒/i.test(pageTitle);
        const initialTaxRate = isLikelyFood ? 0.08 : 0.10;
        rakutenData.taxExcludedPrice = Math.floor(rakutenData.price / (1 + initialTaxRate));
        updated = true;
      }

      if (updated) {
        // 追加ポイントと実質仕入れ値を再計算
        const savedExtraRate = parseInt(localStorage.getItem("rd-extra-point-rate"), 10) || 0;
        rakutenData.extraPointRate = savedExtraRate;
        const extraPoints = Math.floor(rakutenData.taxExcludedPrice * (savedExtraRate / 100));
        rakutenData.extraPoints = Math.abs(extraPoints);
        rakutenData.netCost = rakutenData.price - Math.abs(rakutenData.points) - Math.abs(extraPoints) - rakutenData.coupon;

        // JANコードが新しく取得できた場合はAmazonデータも取得し直す
        if (rakutenData.janCode && (!currentAmazonData || currentAmazonData.error)) {
          await fetchAndRenderAmazonData(rakutenData);
        } else {
          // それ以外は再描画のみ
          renderDashboard(rakutenData, currentAmazonData);
        }
      }
    }, delay);
  });
}

// ============================================================
// メイン実行処理（IIFE）
// ============================================================
(async () => {
  try {
    const hostname = window.location.hostname;
    // 詳細ページ (item.rakuten.co.jp) 以外では実行しないようにする
    if (hostname !== "item.rakuten.co.jp") {
      // 念のため、フォールバック要素（item-page-app-dataなど）がない場合は起動しない
      if (!document.getElementById("item-page-app-data") && !document.querySelector(".item-price, .primary--2kjQA")) {
        console.log("ResearchDeck: 商品詳細ページではないため起動をスキップします");
        return;
      }
    }

    await initializeDetailPage();
    console.log("ResearchDeck: Content Script 処理が完了しました");
  } catch (err) {
    console.error("ResearchDeck: 予期しないエラーが発生しました -", err);
  }
})();
