// ============================================================
// ResearchDeck - SP-API クライアント
// Amazon Selling Partner APIとの通信を担当するモジュール
// LWAトークン管理、各APIエンドポイントへのリクエストを一元管理
// ============================================================

// --- SP-API の基本設定 ---
// Far East リージョン（日本）のエンドポイント
const SP_API_ENDPOINT = "https://sellingpartnerapi-fe.amazon.com";
// LWA（Login with Amazon）トークン取得用エンドポイント
const LWA_TOKEN_ENDPOINT = "https://api.amazon.com/auth/o2/token";
// 日本のマーケットプレイスID
const MARKETPLACE_ID_JP = "A1VC38T7YXB528";

// ============================================================
// トークン管理
// ============================================================

/**
 * chrome.storage.local からSP-API認証情報を取得する
 * Options Pageで保存された値を読み出す
 *
 * @returns {Promise<Object|null>} 認証情報オブジェクト、未設定ならnull
 */
async function getCredentials() {
  const data = await chrome.storage.local.get([
    "sp_client_id",
    "sp_client_secret",
    "sp_refresh_token",
    "sp_seller_id",
  ]);

  // 必須項目がすべて揃っているかチェック
  if (!data.sp_client_id || !data.sp_client_secret || !data.sp_refresh_token || !data.sp_seller_id) {
    return null;
  }

  return {
    clientId: data.sp_client_id,
    clientSecret: data.sp_client_secret,
    refreshToken: data.sp_refresh_token,
    sellerId: data.sp_seller_id,
  };
}

/**
 * LWAリフレッシュトークンを使ってアクセストークンを取得する
 * アクセストークンは1時間有効。期限切れ前に自動更新する。
 *
 * @param {Object} credentials - 認証情報 { clientId, clientSecret, refreshToken }
 * @returns {Promise<string>} アクセストークン文字列
 * @throws {Error} トークン取得に失敗した場合
 */
async function fetchAccessToken(credentials) {
  // キャッシュされたトークンがまだ有効か確認
  const cached = await chrome.storage.local.get(["sp_access_token", "sp_token_expires_at"]);
  if (cached.sp_access_token && cached.sp_token_expires_at) {
    const now = Date.now();
    // 有効期限の5分前までなら再利用（余裕を持たせる）
    if (now < cached.sp_token_expires_at - 5 * 60 * 1000) {
      return cached.sp_access_token;
    }
  }

  // トークンの新規取得
  console.log("ResearchDeck: LWAアクセストークンを取得中...");

  const response = await fetch(LWA_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`LWAトークン取得失敗 (HTTP ${response.status}): ${errorBody}`);
  }

  const tokenData = await response.json();

  // トークンをキャッシュに保存（expires_in は秒数で返される）
  const expiresAt = Date.now() + tokenData.expires_in * 1000;
  await chrome.storage.local.set({
    sp_access_token: tokenData.access_token,
    sp_token_expires_at: expiresAt,
  });

  console.log("ResearchDeck: アクセストークンを取得しました");
  return tokenData.access_token;
}

// ============================================================
// API リクエスト共通処理
// ============================================================

/**
 * SP-APIにGETリクエストを送信する汎用関数
 * アクセストークンのヘッダー付与とエラーハンドリングを共通化
 *
 * @param {string} path - APIのパス（例: "/catalog/2022-04-01/items"）
 * @param {Object} params - クエリパラメータのオブジェクト
 * @param {string} accessToken - LWAアクセストークン
 * @returns {Promise<Object>} APIレスポンスのJSONデータ
 */
async function spApiGet(path, params, accessToken, retryCount = 0) {
  const MAX_RETRIES = 3;
  const url = new URL(path, SP_API_ENDPOINT);
  // クエリパラメータを追加
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, value);
    }
  }

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-amz-access-token": accessToken,
        "Content-Type": "application/json",
      },
    });

    // レート制限（429）または一時的なサーバーエラー（5xx）の場合はリトライ
    if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
      if (retryCount < MAX_RETRIES) {
        const delay = Math.pow(2, retryCount + 1) * 1000; // 2秒, 4秒, 8秒
        console.warn(`ResearchDeck: 一時的エラー (HTTP ${response.status})。${delay / 1000}秒後にリトライします (${retryCount + 1}/${MAX_RETRIES})...`);
        await new Promise((r) => setTimeout(r, delay));
        return spApiGet(path, params, accessToken, retryCount + 1);
      }
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`SP-API エラー (${path}, HTTP ${response.status}): ${errorBody}`);
    }

    return response.json();
  } catch (err) {
    // ネットワーク瞬断などの通信エラー時もリトライ
    if (retryCount < MAX_RETRIES) {
      const delay = Math.pow(2, retryCount + 1) * 1000;
      console.warn(`ResearchDeck: 通信エラー (${err.message})。${delay / 1000}秒後にリトライします (${retryCount + 1}/${MAX_RETRIES})...`);
      await new Promise((r) => setTimeout(r, delay));
      return spApiGet(path, params, accessToken, retryCount + 1);
    }
    throw err;
  }
}

/**
 * SP-APIにPOSTリクエストを送信する汎用関数
 *
 * @param {string} path - APIのパス
 * @param {Object} body - リクエストボディのオブジェクト
 * @param {string} accessToken - LWAアクセストークン
 * @returns {Promise<Object>} APIレスポンスのJSONデータ
 */
async function spApiPost(path, body, accessToken, retryCount = 0) {
  const MAX_RETRIES = 3;
  try {
    const response = await fetch(`${SP_API_ENDPOINT}${path}`, {
      method: "POST",
      headers: {
        "x-amz-access-token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    // レート制限（429）または一時的なサーバーエラー（5xx）の場合はリトライ
    if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
      if (retryCount < MAX_RETRIES) {
        const delay = Math.pow(2, retryCount + 1) * 1000; // 2秒, 4秒, 8秒
        console.warn(`ResearchDeck: 一時的エラー (HTTP ${response.status})。${delay / 1000}秒後にリトライします (${retryCount + 1}/${MAX_RETRIES})...`);
        await new Promise((r) => setTimeout(r, delay));
        return spApiPost(path, body, accessToken, retryCount + 1);
      }
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`SP-API エラー (${path}, HTTP ${response.status}): ${errorBody}`);
    }

    return response.json();
  } catch (err) {
    // ネットワーク瞬断などの通信エラー時もリトライ
    if (retryCount < MAX_RETRIES) {
      const delay = Math.pow(2, retryCount + 1) * 1000;
      console.warn(`ResearchDeck: 通信エラー (${err.message})。${delay / 1000}秒後にリトライします (${retryCount + 1}/${MAX_RETRIES})...`);
      await new Promise((r) => setTimeout(r, delay));
      return spApiPost(path, body, accessToken, retryCount + 1);
    }
    throw err;
  }
}

// ============================================================
// 各SP-APIエンドポイントのラッパー関数
// ============================================================

/**
 * Catalog Items API: JANコード（EAN）からASINとカテゴリ情報を取得する
 *
 * @param {string} janCode - JANコード（13桁）
 * @param {string} accessToken - アクセストークン
 * @returns {Promise<Object|null>} { asin, title, categoryName, salesRank } またはnull
 */
async function searchCatalogByJan(janCode, accessToken) {
  try {
    const data = await spApiGet(
      "/catalog/2022-04-01/items",
      {
        identifiers: janCode,
        identifiersType: "EAN",
        marketplaceIds: MARKETPLACE_ID_JP,
        includedData: "summaries,salesRanks,identifiers,dimensions,relationships",
        locale: "ja_JP", // 日本語のカテゴリ名・タイトルを確実に取得する
      },
      accessToken
    );

    // 検索結果が空の場合
    if (!data.items || data.items.length === 0) {
      return null;
    }

    const item = data.items[0];
    const asin = item.asin;

    // サマリー情報（タイトル・カテゴリ）を抽出
    let title = "";
    let categoryName = "";
    if (item.summaries && item.summaries.length > 0) {
      const summary = item.summaries[0];
      title = summary.itemName || "";
      // browseClassification がカテゴリ情報
      if (summary.browseClassification) {
        categoryName = summary.browseClassification.displayName || "";
      }
    }

    // 売れ筋ランキングを抽出
    let salesRank = null;
    let salesRankCategory = "";
    if (item.salesRanks && item.salesRanks.length > 0) {
      // 日本マーケットプレイスのランキングを優先
      const jpRanks = item.salesRanks.find((r) => r.marketplaceId === MARKETPLACE_ID_JP) || item.salesRanks[0];
      if (jpRanks) {
        let targetRank = null;

        // 大分類（displayGroupRanks: Website Display Group）を最優先にする
        if (jpRanks.displayGroupRanks && jpRanks.displayGroupRanks.length > 0) {
          targetRank = jpRanks.displayGroupRanks[0];
        } 
        // 大分類がない場合は、小分類（classificationRanks: Browse Classification）をフォールバックとして使用
        else if (jpRanks.classificationRanks && jpRanks.classificationRanks.length > 0) {
          targetRank = jpRanks.classificationRanks[0];
        }

        if (targetRank) {
          salesRank = targetRank.rank;
          salesRankCategory = targetRank.title || "";
        }
      }
    }

    // バリエーション関係（VARIATION）の有無をチェック
    let hasVariations = false;
    if (item.relationships && item.relationships.length > 0) {
      for (const relGroup of item.relationships) {
        if (relGroup.relationships && relGroup.relationships.length > 0) {
          const hasVarRel = relGroup.relationships.some(
            r => r.type === "VARIATION" && 
            ((r.parentAsins && r.parentAsins.length > 0) || (r.childAsins && r.childAsins.length > 0))
          );
          if (hasVarRel) {
            hasVariations = true;
            break;
          }
        }
      }
    }

    return {
      asin,
      title,
      categoryName: salesRankCategory || categoryName,
      salesRank,
      dimensions: item.dimensions || null,
      hasVariations,
    };
  } catch (err) {
    console.error("ResearchDeck: Catalog Items API エラー -", err.message);
    throw err;
  }
}

/**
 * Catalog Items API: ASINから商品情報を直接取得する
 *
 * @param {string} asin - ASIN
 * @param {string} accessToken - アクセストークン
 * @returns {Promise<Object|null>} カタログ情報
 */
async function getCatalogItemByAsin(asin, accessToken) {
  try {
    const item = await spApiGet(
      `/catalog/2022-04-01/items/${asin}`,
      {
        marketplaceIds: MARKETPLACE_ID_JP,
        includedData: "summaries,salesRanks,identifiers,dimensions,relationships",
        locale: "ja_JP",
      },
      accessToken
    );

    if (!item) {
      return null;
    }

    // サマリー情報（タイトル・カテゴリ）を抽出
    let title = "";
    let categoryName = "";
    if (item.summaries && item.summaries.length > 0) {
      const summary = item.summaries[0];
      title = summary.itemName || "";
      if (summary.browseClassification) {
        categoryName = summary.browseClassification.displayName || "";
      }
    }

    // 売れ筋ランキングを抽出
    let salesRank = null;
    let salesRankCategory = "";
    if (item.salesRanks && item.salesRanks.length > 0) {
      const jpRanks = item.salesRanks.find((r) => r.marketplaceId === MARKETPLACE_ID_JP) || item.salesRanks[0];
      if (jpRanks) {
        let targetRank = null;
        if (jpRanks.displayGroupRanks && jpRanks.displayGroupRanks.length > 0) {
          targetRank = jpRanks.displayGroupRanks[0];
        } else if (jpRanks.classificationRanks && jpRanks.classificationRanks.length > 0) {
          targetRank = jpRanks.classificationRanks[0];
        }

        if (targetRank) {
          salesRank = targetRank.rank;
          salesRankCategory = targetRank.title || "";
        }
      }
    }

    // バリエーション関係（VARIATION）の有無をチェック
    let hasVariations = false;
    if (item.relationships && item.relationships.length > 0) {
      for (const relGroup of item.relationships) {
        if (relGroup.relationships && relGroup.relationships.length > 0) {
          const hasVarRel = relGroup.relationships.some(
            r => r.type === "VARIATION" && 
            ((r.parentAsins && r.parentAsins.length > 0) || (r.childAsins && r.childAsins.length > 0))
          );
          if (hasVarRel) {
            hasVariations = true;
            break;
          }
        }
      }
    }

    // JANコード (EAN) の抽出
    let ean = null;
    if (item.identifiers && item.identifiers.length > 0) {
      const jpIdentifiers = item.identifiers.find(id => id.marketplaceId === MARKETPLACE_ID_JP) || item.identifiers[0];
      if (jpIdentifiers && jpIdentifiers.identifiers && jpIdentifiers.identifiers.length > 0) {
        const eanId = jpIdentifiers.identifiers.find(i => i.identifierType === "EAN");
        if (eanId) {
          ean = eanId.identifier;
        }
      }
    }

    return {
      asin,
      title,
      categoryName: salesRankCategory || categoryName,
      salesRank,
      dimensions: item.dimensions || null,
      hasVariations,
      janCode: ean, // EANを格納
    };
  } catch (err) {
    console.error("ResearchDeck: Catalog Items API (ASIN) エラー -", err.message);
    throw err;
  }
}


/**
 * Product Pricing API (Get Pricing) から新品の最安値を取得するフォールバック処理
 * カート獲得者（Buy Box）が不在などの理由で competitivePrice から価格が取得できない場合に実行されます。
 * @param {string} asin - Amazon商品識別コード
 * @param {string} accessToken - アクセストークン
 * @returns {Promise<number|null>} 最安値の数値（円）または取得失敗時はnull
 */
// ============================================================
// 価格抽出ヘルパー関数（APIレスポンスのキー大文字小文字の揺れを吸収する）
// ============================================================

/**
 * MoneyType オブジェクトから数値を安全に抽出する
 * @param {Object} moneyObj - MoneyType オブジェクト（例: ListingPrice）
 * @returns {number} 抽出された数値
 */
function getMoneyAmount(moneyObj) {
  if (!moneyObj) return 0;
  // Amount (PascalCase) または amount (camelCase) のいずれかから取得
  const amt = moneyObj.Amount !== undefined ? moneyObj.Amount : moneyObj.amount;
  return parseFloat(amt) || 0;
}

/**
 * PriceType オブジェクト（LandedPrice / ListingPrice を含む）から数値を安全に抽出する
 * LandedPrice（配送料込み）を優先し、無ければ ListingPrice を使用する
 * @param {Object} priceObj - PriceType オブジェクト
 * @returns {number} 抽出された数値
 */
function getPriceVal(priceObj) {
  if (!priceObj) return 0;
  // LandedPrice または landedPrice
  const landed = priceObj.LandedPrice !== undefined ? priceObj.LandedPrice : priceObj.landedPrice;
  if (landed) {
    const amt = getMoneyAmount(landed);
    if (amt > 0) return amt;
  }
  // ListingPrice または listingPrice
  const listing = priceObj.ListingPrice !== undefined ? priceObj.ListingPrice : priceObj.listingPrice;
  if (listing) {
    return getMoneyAmount(listing);
  }
  return 0;
}

/**
 * Product Pricing API (Get Pricing) から新品の最安値を取得するフォールバック処理
 * カート獲得者（Buy Box）が不在などの理由で competitivePrice から価格が取得できない場合に実行されます。
 * @param {string} asin - Amazon商品識別コード
 * @param {string} accessToken - アクセストークン
 * @returns {Promise<number|null>} 最安値の数値（円）または取得失敗時はnull
 */
async function getLowestPriceFallback(asin, accessToken) {
  try {
    console.log("ResearchDeck: カート価格が未検出のため、Get Pricingから最安値を取得します...");
    const data = await spApiGet(
      "/products/pricing/v0/price",
      {
        MarketplaceId: MARKETPLACE_ID_JP,
        Asins: asin,
        ItemType: "Asin",
      },
      accessToken
    );

    if (data.payload && data.payload.length > 0) {
      const product = data.payload[0];
      
      // 個別ASINに対するステータスを検証（Success以外のエラー時は例外を投げる）
      if (product.status !== "Success") {
        const errMsg = product.errors && product.errors.length > 0 
          ? product.errors[0].message 
          : `API処理エラー (Status: ${product.status})`;
        console.error(`ResearchDeck: Price API 個別エラー (${asin}) -`, errMsg);
        throw new Error(errMsg);
      }
      
      const prodObj = product.Product || product.product;

      // 1. LowestOffers（出品中の最安値リスト）から新品（New/new）の最安値を探す
      const lowestOffers = prodObj ? (prodObj.LowestOffers || prodObj.lowestOffers) : null;
      if (lowestOffers && lowestOffers.length > 0) {
        let lowestPrice = null;
        for (const offer of lowestOffers) {
          // 新品のみを判定対象とする
          const condition = offer.lowestOfferCondition || offer.LowestOfferCondition || offer.condition;
          if (condition && condition.toLowerCase() === "new") {
            const priceObj = offer.Price || offer.price;
            if (priceObj) {
              const amount = getPriceVal(priceObj);
              if (amount > 0 && (lowestPrice === null || amount < lowestPrice)) {
                lowestPrice = amount;
              }
            }
          }
        }
        if (lowestPrice !== null) {
          console.log("ResearchDeck: Get Pricing から最安値を取得しました:", lowestPrice);
          return { lowestPrice, rawData: data };
        }
      }
      
      // 2. フォールバックのフォールバック：Offersリスト（個別出品者情報）から最安値を取得
      const offers = prodObj ? (prodObj.Offers || prodObj.offers) : null;
      if (offers && offers.length > 0) {
        let lowestOfferPrice = null;
        for (const offer of offers) {
          const buyingPriceObj = offer.BuyingPrice || offer.buyingPrice;
          if (buyingPriceObj) {
            const price = getPriceVal(buyingPriceObj);
            if (price > 0 && (lowestOfferPrice === null || price < lowestOfferPrice)) {
              lowestOfferPrice = price;
            }
          }
        }
        if (lowestOfferPrice !== null) {
          console.log("ResearchDeck: Offersリストから価格を取得しました:", lowestOfferPrice);
          return { lowestPrice: lowestOfferPrice, rawData: data };
        }
      }
    }
    return { lowestPrice: null, rawData: data };
  } catch (err) {
    console.warn("ResearchDeck: Get Pricing フォールバック取得に失敗しました:", err.message);
    return { lowestPrice: null, rawData: null, error: err.message };
  }
}

/**
 * Product Pricing API (Get Item Offers) から出品者全体の最安値オファーを取得する
 * カート獲得者がいない、またはGet Pricing APIで情報が取れない場合の最終フォールバック。
 * セラー自身が出品していなくても、他のセラーの価格を含む出品一覧（Offers）から最安値を取得できます。
 *
 * @param {string} asin - Amazon商品識別コード
 * @param {string} accessToken - アクセストークン
 * @returns {Promise<Object>} { lowestPrice, rawData }
 */
async function getItemOffersPrice(asin, accessToken) {
  try {
    console.log("ResearchDeck: カート価格および最安値が未検出のため、Get Item Offersから取得します...");
    const data = await spApiGet(
      `/products/pricing/v0/items/${asin}/offers`,
      {
        MarketplaceId: MARKETPLACE_ID_JP,
        ItemCondition: "New", // 新品のオファーのみ取得
      },
      accessToken
    );

    let lowestPrice = null;

    if (data.payload) {
      const payload = data.payload;
      const offers = payload.Offers || payload.offers;

      // 1. payload.Offers から最安値を探す
      if (offers && offers.length > 0) {
        for (const offer of offers) {
          // getItemOffers のレスポンスに含まれるオファー情報の価格オブジェクト
          // BuyingPrice (または buyingPrice) を優先し、無ければ直接 ListingPrice (または listingPrice) を見る
          const buyingPriceObj = offer.BuyingPrice || offer.buyingPrice;
          if (buyingPriceObj) {
            const price = getPriceVal(buyingPriceObj);
            if (price > 0 && (lowestPrice === null || price < lowestPrice)) {
              lowestPrice = price;
            }
          } else {
            // BuyingPrice が無く、直接 ListingPrice / Shipping 等がある場合への対応
            const price = getPriceVal(offer);
            if (price > 0 && (lowestPrice === null || price < lowestPrice)) {
              lowestPrice = price;
            }
          }
        }
      }

      // 2. Offersから取得できない場合、payload.Summary.LowestPrices から探す
      const summary = payload.Summary || payload.summary;
      const lowestPrices = summary ? (summary.LowestPrices || summary.lowestPrices) : null;
      if (lowestPrice === null && lowestPrices && lowestPrices.length > 0) {
        for (const priceObj of lowestPrices) {
          const price = getPriceVal(priceObj);
          if (price > 0 && (lowestPrice === null || price < lowestPrice)) {
            lowestPrice = price;
          }
        }
      }
    }

    if (lowestPrice !== null) {
      console.log("ResearchDeck: Get Item Offers から最安値を取得しました:", lowestPrice);
    }
    return { lowestPrice, rawData: data };
  } catch (err) {
    console.warn("ResearchDeck: Get Item Offers 取得に失敗しました:", err.message);
    return { lowestPrice: null, rawData: null, error: err.message };
  }
}

/**
 * Product Pricing API: ASINのAmazon現在価格を取得する
 * 1. カート価格（Buy Box）、2. 個別オファー最安値、3. Get Pricing APIによる最安値リスト、4. Get Item Offers（最終手段）を順に試行します。
 *
 * @param {string} asin - Amazon商品識別コード
 * @param {string} accessToken - アクセストークン
 * @returns {Promise<Object>} { currentPrice, currencyCode, rawData, rawFallbackData }
 */
async function getProductPricing(asin, accessToken) {
  try {
    // 他社商品や未出品の商品でもカート価格（最安値）を確実に取得するため、
    // まずは competitivePrice エンドポイントを使用する
    const data = await spApiGet(
      "/products/pricing/v0/competitivePrice",
      {
        MarketplaceId: MARKETPLACE_ID_JP,
        Asins: asin,
        ItemType: "Asin",
      },
      accessToken
    );

    let currentPrice = null;
    let numberOfNewOffers = null; // 新品の出品者数（ライバル数）
    const currencyCode = "JPY";

    if (data.payload && data.payload.length > 0) {
      const product = data.payload[0];
      
      // 個別ASINに対するステータスを検証（Success以外のエラー時は例外を投げる）
      if (product.status !== "Success") {
        const errMsg = product.errors && product.errors.length > 0 
          ? product.errors[0].message 
          : `API処理エラー (Status: ${product.status})`;
        console.error(`ResearchDeck: Price API 個別エラー (${asin}) -`, errMsg);
        throw new Error(errMsg);
      }
      
      const prodObj = product.Product || product.product;
      const competitivePricing = prodObj ? (prodObj.CompetitivePricing || prodObj.competitivePricing) : null;

      // 1. カート価格（Buy Box）などの競争力のある価格を優先取得
      if (competitivePricing) {
        const competitivePrices = competitivePricing.CompetitivePrices || competitivePricing.competitivePrices;
        if (competitivePrices && competitivePrices.length > 0) {
          for (const price of competitivePrices) {
            const priceObj = price.Price || price.price;
            if (priceObj) {
              const amount = getPriceVal(priceObj);
              if (amount > 0) {
                currentPrice = amount;
                break; // 最初の有効な価格を採用
              }
            }
          }
        }

        // 出品者数（NumberOfOffers）を抽出する
        // CompetitivePricing → NumberOfOfferListings (または numberOfOfferListings) から新品のオファー数を取得
        const offerListings = competitivePricing.NumberOfOfferListings || competitivePricing.numberOfOfferListings;
        if (offerListings && offerListings.length > 0) {
          for (const listing of offerListings) {
            const condition = listing.condition || listing.Condition || "";
            if (condition.toLowerCase() === "new") {
              numberOfNewOffers = listing.Count || listing.count || 0;
              break;
            }
          }
          // 条件別のデータが無い場合は、最初のエントリの値を使用
          if (numberOfNewOffers === null && offerListings.length > 0) {
            numberOfNewOffers = offerListings[0].Count || offerListings[0].count || 0;
          }
        }
      }
      
      // 2. カート価格が取れない場合のフォールバックとして個別オファーの最安値を取得
      const offers = prodObj ? (prodObj.Offers || prodObj.offers) : null;
      if (currentPrice === null && offers && offers.length > 0) {
        for (const offer of offers) {
          const buyingPriceObj = offer.BuyingPrice || offer.buyingPrice;
          if (buyingPriceObj) {
            const price = getPriceVal(buyingPriceObj);
            if (price > 0 && (currentPrice === null || price < currentPrice)) {
              currentPrice = price;
            }
          }
        }
      }
    }

    // 3. カート価格も個別オファーも取得できなかった場合、Get Pricing API (LowestOffers) にフォールバック
    let rawFallbackData = null;
    if (currentPrice === null) {
      const fallbackResult = await getLowestPriceFallback(asin, accessToken);
      if (fallbackResult) {
        currentPrice = fallbackResult.lowestPrice;
        rawFallbackData = fallbackResult.rawData || fallbackResult.error;
      }
    }

    // 4. それでも取得できなかった場合（セラーが未出品でLowestOffersが空など）、Get Item Offers APIに最終フォールバック
    let rawItemOffersData = null;
    if (currentPrice === null) {
      const itemOffersResult = await getItemOffersPrice(asin, accessToken);
      if (itemOffersResult) {
        currentPrice = itemOffersResult.lowestPrice;
        rawItemOffersData = itemOffersResult.rawData || itemOffersResult.error;
      }
    }

    // デバッグ用として両方のフォールバックデータをマージして返却する
    const mergedFallbackData = {
      lowestPriceFallback: rawFallbackData,
      itemOffersFallback: rawItemOffersData
    };

    return { currentPrice, currencyCode, numberOfNewOffers, rawData: data, rawFallbackData: mergedFallbackData };
  } catch (err) {
    console.error("ResearchDeck: Product Pricing API エラー -", err.message);
    throw err;
  }
}

/**
 * Product Fees API: ASIN FBA手数料を見積もる
 *
 * @param {string} asin - Amazon商品識別コード
 * @param {number} price - 想定販売価格（円）
 * @param {string} accessToken - アクセストークン
 * @returns {Promise<Object>} { referralFee, fbaFulfillmentFee, totalFees }
 */
async function getFeesEstimate(asin, price, accessToken) {
  try {
    const data = await spApiPost(
      `/products/fees/v0/items/${asin}/feesEstimate`,
      {
        FeesEstimateRequest: {
          MarketplaceId: MARKETPLACE_ID_JP,
          IsAmazonFulfilled: true, // FBA前提
          PriceToEstimateFees: {
            ListingPrice: {
              CurrencyCode: "JPY",
              Amount: price,
            },
          },
          Identifier: `rd-${asin}`, // リクエスト識別子
        },
      },
      accessToken
    );

    let referralFee = 0; // 販売手数料（カテゴリごとに8~15%）
    let fbaFulfillmentFee = 0; // FBA配送手数料
    let totalFees = 0;

    const payload = data.payload;
    const feesEstimateResult = payload ? (payload.FeesEstimateResult || payload.feesEstimateResult) : null;
    if (feesEstimateResult) {
      const feesEstimate = feesEstimateResult.FeesEstimate || feesEstimateResult.feesEstimate;
      const feeDetailList = feesEstimate ? (feesEstimate.FeeDetailList || feesEstimate.feeDetailList) : null;
      if (feeDetailList && feeDetailList.length > 0) {
        for (const feeDetail of feeDetailList) {
          const finalFee = feeDetail.FinalFee || feeDetail.finalFee;
          const amount = getMoneyAmount(finalFee);
          
          const feeType = feeDetail.FeeType || feeDetail.feeType;
          if (feeType === "ReferralFee" || feeType === "referralFee") {
            referralFee = amount;
          } else if (feeType === "FBAFees" || feeType === "fbaFees" || feeType === "FulfillmentFees" || feeType === "fulfillmentFees") {
            fbaFulfillmentFee = amount;
          }
        }
        // 合計手数料
        const totalFeesEstimate = feesEstimate.TotalFeesEstimate || feesEstimate.totalFeesEstimate;
        if (totalFeesEstimate) {
          totalFees = getMoneyAmount(totalFeesEstimate) || (referralFee + fbaFulfillmentFee);
        } else {
          totalFees = referralFee + fbaFulfillmentFee;
        }
      }
    }

    return { referralFee, fbaFulfillmentFee, totalFees };
  } catch (err) {
    console.error("ResearchDeck: Product Fees API エラー -", err.message);
    throw err;
  }
}

/**
 * Listings Restrictions API: 出品制限の有無を確認する
 * 自分のアカウントでその商品を出品できるか判定
 *
 * @param {string} asin - Amazon商品識別コード
 * @param {string} sellerId - 出品者ID
 * @param {string} accessToken - アクセストークン
 * @returns {Promise<Object>} { canSell, requiresApproval, reasons, approvalLink }
 */
async function getListingsRestrictions(asin, sellerId, accessToken) {
  try {
    const data = await spApiGet(
      "/listings/2021-08-01/restrictions",
      {
        asin: asin,
        sellerId: sellerId,
        marketplaceIds: MARKETPLACE_ID_JP,
        conditionType: "new_new", // 新品での出品可否を確認
      },
      accessToken
    );

    // restrictions が空配列なら出品制限なし（出品可能）
    if (!data.restrictions || data.restrictions.length === 0) {
      return {
        canSell: true,
        requiresApproval: false,
        reasons: [],
        approvalLink: null,
      };
    }

    // 制限がある場合、詳細を解析
    const reasons = [];
    let requiresApproval = false;
    let canSell = true;
    let approvalLink = null;

    for (const restriction of data.restrictions) {
      // conditionType が一致する制限のみチェック
      if (restriction.reasons) {
        for (const reason of restriction.reasons) {
          reasons.push(reason.message || "出品制限あり");

          // 承認申請が可能な場合
          if (reason.links && reason.links.length > 0) {
            requiresApproval = true;
            // 申請用URL（resourceプロパティ）を取り出す
            const linkObj = reason.links[0];
            if (linkObj && linkObj.resource) {
              approvalLink = linkObj.resource;
            }
          }
        }
      }
    }

    // 制限がある時点で単純な出品はできない
    canSell = false;

    return {
      canSell,
      requiresApproval,
      reasons,
      approvalLink,
    };
  } catch (err) {
    console.error("ResearchDeck: Listings Restrictions API エラー -", err.message);
    throw err;
  }
}
