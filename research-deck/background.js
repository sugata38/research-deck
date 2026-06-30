// ============================================================
// ResearchDeck - Service Worker（バックグラウンド処理）
// Content Scriptからのリクエストを受けて、
// SP-APIへの通信を実行し、結果を返却する
// ============================================================

// --- Service WorkerでモジュールをimportScript ---
// Manifest V3のService Workerではimportが使えないため、
// importScriptsで読み込む
importScripts("lib/sp-api-client.js", "lib/sales-estimator.js");

// ============================================================
// メッセージリスナー
// Content Scriptからのリクエストを受信して処理する
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 非同期処理をラップして、return true でチャネルを維持
  if (message.type === "FETCH_AMAZON_DATA") {
    handleFetchAmazonData(message.janCode)
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error("ResearchDeck: Amazon データ取得失敗 -", err);
        sendResponse({
          success: false,
          error: err.message,
        });
      });
    return true; // 非同期レスポンスのためチャネルを開いたままにする
  }

  // SP-API接続テストのリクエスト（Options Pageから）
  if (message.type === "TEST_SP_API_CONNECTION") {
    handleTestConnection()
      .then((result) => sendResponse(result))
      .catch((err) => {
        sendResponse({
          success: false,
          error: err.message,
        });
      });
    return true;
  }

  // SP-API認証情報が設定済みかどうかの確認
  if (message.type === "CHECK_SP_API_CONFIGURED") {
    getCredentials()
      .then((creds) => {
        sendResponse({ configured: creds !== null });
      })
      .catch(() => {
        sendResponse({ configured: false });
      });
    return true;
  }

  // オプション（設定）画面を開くリクエスト
  if (message.type === "OPEN_OPTIONS_PAGE") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return true;
  }
});

// ============================================================
// Amazonデータ取得の統合処理
// JANコードを受け取り、各SP-APIを順次呼び出して結果をまとめる
// ============================================================

/**
 * JANコードからAmazonの全データを取得する統合関数
 *
 * 処理の流れ:
 * 1. 認証情報チェック → アクセストークン取得
 * 2. Catalog Items API → ASIN・カテゴリ・ランキング
 * 3. Product Pricing API → 現在価格
 * 4. Product Fees API → FBA手数料
 * 5. Listings Restrictions API → 出品可否
 * 6. 月間販売数を推定
 *
 * @param {string} janCode - JANコード（13桁）
 * @returns {Promise<Object>} 全データを含む結果オブジェクト
 */
async function handleFetchAmazonData(janCode) {
  // --- 1. 認証情報の取得 ---
  const credentials = await getCredentials();
  if (!credentials) {
    return {
      success: false,
      error: "SP-API_NOT_CONFIGURED",
    };
  }

  // --- 2. アクセストークンの取得（キャッシュ or 新規） ---
  let accessToken;
  try {
    accessToken = await fetchAccessToken(credentials);
  } catch (err) {
    return {
      success: false,
      error: `認証エラー: ${err.message}`,
    };
  }

  // --- 3. Catalog Items API: JANコードからASINを特定 ---
  let catalogData;
  try {
    catalogData = await searchCatalogByJan(janCode, accessToken);
  } catch (err) {
    return {
      success: false,
      error: `カタログ検索エラー: ${err.message}`,
    };
  }

  if (!catalogData) {
    return {
      success: false,
      error: "PRODUCT_NOT_FOUND",
    };
  }

  console.log("ResearchDeck: ASIN特定 →", catalogData.asin);

  // --- 4〜5. 価格・出品可否を並行取得 ---
  // それぞれ独立したAPI呼び出しなので、Promise.allSettledで並行実行
  const [pricingResult, restrictionsResult] = await Promise.allSettled([
    // 4. Product Pricing API: 現在価格
    getProductPricing(catalogData.asin, accessToken),
    // 5. Listings Restrictions API: 出品可否
    getListingsRestrictions(catalogData.asin, credentials.sellerId, accessToken),
  ]);

  // --- 価格の取得結果を処理 ---
  let amazonPrice = null;
  let numberOfNewOffers = null; // 新品の出品者数（ライバル数）
  let pricingError = null; // エラーメッセージ保持用
  let rawPricingData = null; // デバッグ用生データ
  if (pricingResult.status === "fulfilled" && pricingResult.value) {
    amazonPrice = pricingResult.value.currentPrice;
    numberOfNewOffers = pricingResult.value.numberOfNewOffers;
    rawPricingData = {
      competitivePricing: pricingResult.value.rawData,
      getPricingFallback: pricingResult.value.rawFallbackData
    };
    if (amazonPrice === null) {
      pricingError = "APIからの応答に有効な現在価格（カート価格または最安値出品価格）が見つかりませんでした。";
    }
    console.log("ResearchDeck: Amazon価格の取得に成功しました。価格:", amazonPrice);
  } else if (pricingResult.status === "rejected") {
    pricingError = pricingResult.reason.message || String(pricingResult.reason);
    console.error("ResearchDeck: Amazon価格の取得に失敗しました。原因:", pricingError);
  }

  // --- 7. 月間保管手数料の計算 ---
  const storageFeeResult = calculateMonthlyStorageFee(
    catalogData.dimensions,
    catalogData.categoryName
  );
  const monthlyStorageFee = storageFeeResult.fee;
  const monthlyStorageFeeDetails = storageFeeResult.details;

  // --- 手数料の取得（価格が判明した後に正確な計算） ---
  let feesData = { referralFee: 0, fbaFulfillmentFee: 0, totalFees: 0 };
  if (amazonPrice && amazonPrice > 0) {
    try {
      feesData = await getFeesEstimate(catalogData.asin, amazonPrice, accessToken);
    } catch (err) {
      console.warn("ResearchDeck: 手数料取得に失敗。概算を使用します。", err.message);
    }
  }

  // --- 手数料の計算（販売手数料のみ消費税 10% を適用） ---
  // Amazonの仕様上、販売手数料（Referral Fee）は税抜表記、その他の手数料（FBA配送代行手数料、保管手数料等）は
  // すでに税込表記となっているため、販売手数料のみに国内消費税率（10%）を上乗せします。
  const TAX_RATE = 1.10;
  const referralFeeTaxed = Math.round(feesData.referralFee * TAX_RATE);
  const fbaFulfillmentFee = feesData.fbaFulfillmentFee; // FBA配送手数料（すでに税込）
  const monthlyStorageFeeVal = monthlyStorageFee; // 月間保管手数料（すでに税込）

  // 各手数料を合計したFBA手数料合計
  const totalFeesTaxed = referralFeeTaxed + fbaFulfillmentFee + monthlyStorageFeeVal;

  // --- 出品可否の取得結果を処理 ---
  let listingsData = { canSell: null, requiresApproval: false, reasons: [], approvalLink: null };
  if (restrictionsResult.status === "fulfilled" && restrictionsResult.value) {
    listingsData = restrictionsResult.value;
  } else if (restrictionsResult.status === "rejected") {
    console.error("ResearchDeck: 出品制限情報の取得に失敗しました。原因:", restrictionsResult.reason);
  }

  // --- 8. 月間販売数の推定 ---
  const salesEstimate = estimateMonthlySales(
    catalogData.salesRank,
    catalogData.categoryName
  );

  // --- 全データをまとめて返却 ---
  return {
    success: true,
    data: {
      // 商品情報
      asin: catalogData.asin,
      title: catalogData.title,
      categoryName: catalogData.categoryName,

      // 価格・手数料
      amazonPrice,
      referralFee: referralFeeTaxed,
      fbaFulfillmentFee: fbaFulfillmentFee,
      monthlyStorageFee: monthlyStorageFeeVal, // 月間保管手数料（個別の値、税込）
      monthlyStorageFeeDetails, // 保管手数料の計算内訳
      totalFees: totalFeesTaxed, // 保管手数料加算後の手数料合計（税込）
      pricingError, // エラー内容をフロントへ伝播する
      rawPricingData, // デバッグ用生データをフロントへ伝播する

      // 出品可否
      canSell: listingsData.canSell,
      requiresApproval: listingsData.requiresApproval,
      restrictionReasons: listingsData.reasons,
      approvalLink: listingsData.approvalLink, // 申請用リンク

      // 出品者数（ライバル数）
      numberOfNewOffers,

      // ランキング・販売推定
      salesRank: catalogData.salesRank,
      estimatedMonthlySales: salesEstimate.estimatedMonthlySales,
      salesEstimateConfidence: salesEstimate.confidence,
      salesEstimateCategoryUsed: salesEstimate.categoryUsed,
      hasVariations: catalogData.hasVariations,
    },
  };
}

/**
 * 商品寸法（dimensions）とカテゴリ名から、FBAの月間保管手数料を計算する
 * @param {Array} dimensions - SP-APIから取得したdimensions配列
 * @param {string} categoryName - カテゴリ名（アパレル判定に使用）
 * @returns {number} 1ヶ月分の月間保管手数料（円、端数四捨五入）。計算不可時は0
 */
function calculateMonthlyStorageFee(dimensions, categoryName) {
  if (!dimensions || !Array.isArray(dimensions) || dimensions.length === 0) {
    return { fee: 0, details: null };
  }

  // 日本マーケットプレイスの寸法データを取得
  const MARKETPLACE_ID_JP = "A1VC38T7YXB528";
  const jpDimensions = dimensions.find((d) => d.marketplaceId === MARKETPLACE_ID_JP) || dimensions[0];
  if (!jpDimensions) return { fee: 0, details: null };

  // 梱包サイズ（package）を優先し、無ければ商品サイズ（item）を使用
  const sizeObj = jpDimensions.package || jpDimensions.item;
  if (!sizeObj) return { fee: 0, details: null };

  const heightObj = sizeObj.height;
  const lengthObj = sizeObj.length;
  const widthObj = sizeObj.width;
  const weightObj = sizeObj.weight; // 重量データも取得
  if (!heightObj || !lengthObj || !widthObj) return { fee: 0, details: null };

  // 単位をセンチメートルに統一するヘルパー
  const convertToCm = (dim) => {
    if (!dim || dim.value === undefined) return 0;
    const val = parseFloat(dim.value) || 0;
    const unit = (dim.unit || "").toLowerCase();
    if (unit === "inches" || unit === "inch") {
      return val * 2.54;
    } else if (unit === "millimeters" || unit === "mm") {
      return val / 10;
    }
    return val; // デフォルトは centimeters
  };

  // 重量をkgに統一するヘルパー
  const convertToKg = (weight) => {
    if (!weight || weight.value === undefined) return 0;
    const val = parseFloat(weight.value) || 0;
    const unit = (weight.unit || "").toLowerCase();
    if (unit === "pounds" || unit === "lb" || unit === "lbs") {
      return val * 0.453592;
    } else if (unit === "ounces" || unit === "oz") {
      return val * 0.0283495;
    } else if (unit === "grams" || unit === "g") {
      return val / 1000;
    }
    return val; // デフォルトは kg
  };

  const h = convertToCm(heightObj);
  const l = convertToCm(lengthObj);
  const w = convertToCm(widthObj);
  const weight = convertToKg(weightObj);

  if (h <= 0 || l <= 0 || w <= 0) return { fee: 0, details: null };

  // 三辺を降順ソートして「最長辺」「中間辺」「最短辺」に分ける
  const sides = [h, l, w].sort((a, b) => b - a);
  const longestSide = sides[0];  // 最長辺
  const medianSide = sides[1];   // 中間辺
  const shortestSide = sides[2];  // 最短辺

  // FBAサイズ区分の判定 (小型/標準 vs 大型/特大型)
  // 標準サイズの要件：最長辺 45cm以下、中間辺 35cm以下、最短辺 20cm以下、かつ重量 9kg以下
  const isStandardSize = longestSide <= 45 && medianSide <= 35 && shortestSide <= 20 && weight <= 9;

  // 体積を立方センチメートル(cm3)で計算
  const volume = h * l * w;

  // 現在の月（1〜12）
  const currentMonth = new Date().getMonth() + 1;
  const isQ4 = currentMonth >= 10 && currentMonth <= 12; // 10〜12月は繁忙期レート

  // アパレル判定（服、靴、バッグなど）
  const isApparel = categoryName && (
    categoryName.includes("服") ||
    categoryName.includes("靴") ||
    categoryName.includes("シューズ") ||
    categoryName.includes("バッグ") ||
    categoryName.includes("Clothing") ||
    categoryName.includes("Shoes") ||
    categoryName.includes("Bags")
  );

  // 10cm x 10cm x 10cm (1,000 cm3) あたりの保管手数料基準額（日本・2026年最新体系）
  let baseRate = 0;
  if (isApparel) {
    baseRate = isQ4 ? 5.50 : 3.10;
  } else {
    if (isStandardSize) {
      baseRate = isQ4 ? 10.087 : 5.676;
    } else {
      // 大型/特大型サイズ
      baseRate = isQ4 ? 6.984 : 3.278;
    }
  }

  // 月間保管手数料 = 基準額 × (体積 / 1000)
  const fee = baseRate * (volume / 1000);
  
  return {
    fee: Math.round(fee),
    details: {
      longestSide: Math.round(longestSide * 10) / 10,
      medianSide: Math.round(medianSide * 10) / 10,
      shortestSide: Math.round(shortestSide * 10) / 10,
      weight: Math.round(weight * 100) / 100,
      volume: Math.round(volume),
      isStandardSize,
      isApparel,
      baseRate,
      isQ4
    }
  };
}

// ============================================================
// 接続テスト
// Options Pageから呼ばれ、SP-APIの疎通確認を行う
// ============================================================

/**
 * SP-API接続テスト
 * アクセストークンの取得を試みて、成功すれば接続OK
 *
 * @returns {Promise<Object>} { success, message }
 */
async function handleTestConnection() {
  const credentials = await getCredentials();
  if (!credentials) {
    return {
      success: false,
      error: "認証情報が保存されていません。すべてのフィールドを入力してください。",
    };
  }

  try {
    // アクセストークンの取得を試みる
    const accessToken = await fetchAccessToken(credentials);

    if (accessToken) {
      return {
        success: true,
        message: "SP-APIへの接続に成功しました！",
      };
    } else {
      return {
        success: false,
        error: "トークンの取得に失敗しました。",
      };
    }
  } catch (err) {
    return {
      success: false,
      error: `接続テスト失敗: ${err.message}`,
    };
  }
}

// ============================================================
// アイコンクリック時の動作
// 拡張機能のアイコンをクリックしたら設定画面（Options Page）を開く
// ============================================================

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
