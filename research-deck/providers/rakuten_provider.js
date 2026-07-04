// ============================================================
// ResearchDeck - RakutenProvider
// 楽天市場の商品詳細ページからデータを抽出するプロバイダー
// ============================================================

class RakutenProvider extends BaseProvider {
  constructor(doc = document) {
    super(doc);
    this.siteName = "楽天市場";
    this.pointsName = "獲得ポイント";
    this.extraPointName = "追加ポイント";
    this.extraPointRateDefault = 0;
    this.dotClass = "rd-dot-rakuten";
  }

  /**
   * 楽天市場の商品ページから全データを抽出する
   * @returns {Object} 共通データ構造
   */
  extractData() {
    let janCode = null;
    let price = 0;
    let points = 0;
    let coupon = 0;

    // 1. JSON-LD (構造化データ) からの抽出を最優先とする
    const jsonLdData = this.extractFromJsonLd();
    if (jsonLdData) {
      if (jsonLdData.jan) janCode = jsonLdData.jan;
      if (jsonLdData.price) price = jsonLdData.price;
    }

    // 2. script#item-page-app-data (JSON) からの抽出を試みる
    const appDataEl = this.doc.getElementById("item-page-app-data");
    if (appDataEl) {
      try {
        const rootData = JSON.parse(appDataEl.textContent);
        const item = (rootData.newApi && rootData.newApi.itemInfoSku) || (rootData.api && rootData.api.data && rootData.api.data.itemInfoSku);
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
        console.log("ResearchDeck: item-page-app-dataのパースに失敗しました", e);
      }
    }

    // 3. DOMからのフォールバック抽出
    if (!janCode) {
      janCode = this.extractJanCode();
    }
    
    if (price === 0) {
      price = this.extractPrice();
    }

    // ポイントは「SPU等を含むユーザーの実際の保有ポイント」がDOMに表示されていればそれを優先
    const domPoints = this.extractPoints();
    if (domPoints > 0) {
      points = domPoints;
    } else if (points === 0 && price > 0) {
      // 最終フォールバックとして 1% を仮定
      points = Math.floor(price * 0.01);
    }

    // クーポンもDOMから抽出（商品価格を渡して適用条件を判定できるようにする）
    coupon = this.extractCoupon(price);

    // 獲得ポイント値のマイナスやプラス符号の混入を防ぐため、常に絶対値にする
    const absolutePoints = Math.abs(points);

    return {
      janCode,
      price,
      points: absolutePoints,
      rawPoints: absolutePoints, // クーポン値引き前の生のポイント
      coupon,
      netCost: price - absolutePoints - coupon
    };
  }

  /**
   * 商品説明テーブル内やテキストからJANコードを抽出する
   */
  extractJanCode() {
    // 楽天ビック (biccamera.rakuten.co.jp) の場合、URLのパスからJANコード (13桁または8桁の数値) を最優先で抽出
    if (window.location.hostname.includes("biccamera.rakuten.co.jp")) {
      const urlMatch = window.location.pathname.match(/\/item\/(\d{13}|\d{8})\b/);
      if (urlMatch && this.isValidJanCode(urlMatch[1])) {
        console.log(`ResearchDeck: 楽天ビックのURLからJANコードを検出しました -> ${urlMatch[1]}`);
        return urlMatch[1];
      }
    }

    // 隠しinput要素 (トラッキング用など) からの抽出フォールバック
    const hiddenJanSelectors = [
      'input#ratProductCode',
      'input[name="rat"][id="ratProductCode"]',
      'input#chatItemNumber'
    ];
    for (const selector of hiddenJanSelectors) {
      const el = this.doc.querySelector(selector);
      if (el && el.value && this.isValidJanCode(el.value.trim())) {
        console.log(`ResearchDeck: 隠しinput (${selector}) からJANコードを検出しました -> ${el.value.trim()}`);
        return el.value.trim();
      }
    }

    // 方法1: 商品説明テーブル内の「JAN」行を探す
    const tableRows = this.doc.querySelectorAll(
      "table tr, .item-description table tr, .rakutenLimitedId_ItemDescriptionInner table tr"
    );
    for (const row of tableRows) {
      const headerCell = row.querySelector("th, td:first-child");
      if (headerCell && /jan|ジャン|バーコード/i.test(headerCell.textContent)) {
        const valueCell = row.querySelector("td:last-child, td:nth-child(2)");
        if (valueCell) {
          const match = valueCell.textContent.match(/\d{13}|\d{8}/);
          if (match && this.isValidJanCode(match[0])) return match[0];
        }
      }
    }

    // 方法2: ページ全体のテキストから「JAN:数字」パターンを探す
    const bodyText = this.doc.body ? this.doc.body.textContent : "";
    const janPatterns = [
      /JAN(?:コード)?[\s:：\n\r]*(\d{13})/i,
      /バーコード[\s:：\n\r]*(\d{13})/i,
      /JAN(?:コード)?[\s:：\n\r]*(\d{8})/i,
      /バーコード[\s:：\n\r]*(\d{8})/i,
    ];

    for (const pattern of janPatterns) {
      const match = bodyText.match(pattern);
      if (match && this.isValidJanCode(match[1])) return match[1];
    }

    // ページ内の13桁の独立した数値をすべて抽出して検証（フォールバック）
    const allNumbers13 = bodyText.match(/\b\d{13}\b/g) || [];
    for (const num of allNumbers13) {
      if (this.isValidJanCode(num)) return num;
    }

    // ページ内の8桁の独立した数値をすべて抽出して検証（フォールバック）
    const allNumbers8 = bodyText.match(/\b\d{8}\b/g) || [];
    for (const num of allNumbers8) {
      if (this.isValidJanCode(num)) return num;
    }

    // 方法3: 商品番号を最終フォールバックとして取得
    const itemNumberEl = this.doc.querySelector(
      ".item-number span, .rakutenLimitedId_ItemNumber span"
    );
    if (itemNumberEl) {
      const numMatch = itemNumberEl.textContent.match(/\d+/);
      if (numMatch && this.isValidJanCode(numMatch[0])) return numMatch[0];
    }

    return null;
  }

  /**
   * 楽天の価格表示から価格を抽出する
   */
  extractPrice() {
    // 隠しinput要素 (トラッキング用など) からの価格抽出フォールバック
    const ratPriceEl = this.doc.querySelector('input#ratPrice, input[name="rat"][id="ratPrice"]');
    if (ratPriceEl && ratPriceEl.value) {
      const num = parseInt(ratPriceEl.value.replace(/[^0-9]/g, ""), 10);
      if (!isNaN(num) && num > 0) {
        console.log(`ResearchDeck: 隠しinputから価格を検出しました -> ${num}`);
        return num;
      }
    }

    const metaSelectors = [
      'meta[property="product:price:amount"]',
      'meta[itemprop="price"]',
      'meta[name="twitter:data1"]'
    ];
    
    for (const selector of metaSelectors) {
      const el = this.doc.querySelector(selector);
      if (el) {
        const content = el.getAttribute("content");
        if (content) {
          const num = parseInt(content.replace(/[^0-9]/g, ""), 10);
          if (!isNaN(num) && num > 0) return num;
        }
      }
    }

    const priceSelectors = [
      ".primary--2kjQA", 
      ".price--OX_YW",
      ".price2",
      "[class*='price'] .important",
      ".price",
      ".item-price",
      "#priceCalculationConfig",
      ".rakutenLimitedId_ItemPrice",
      'span[itemprop="price"]',
      ".sale_price",
    ];

    for (const selector of priceSelectors) {
      const el = this.doc.querySelector(selector);
      if (el) {
        const contentAttr = el.getAttribute("content");
        if (contentAttr) {
          const num = parseInt(contentAttr, 10);
          if (!isNaN(num) && num > 0) return num;
        }

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
   * 楽天のポイント表示から獲得予定ポイントを抽出する
   */
  extractPoints() {
    const allElements = this.doc.getElementsByTagName("*");
    for (const el of allElements) {
      // 共通コンポーネントエリア（ヘッダー、フッター、ナビ、メニュー、おすすめ広告等）をスキップして誤検知を防ぐ
      if (el.closest && el.closest('header, footer, nav, menu, [class*="recommend" i]')) {
        continue;
      }
      if (el.textContent && /^(内訳|ポイントの内訳)$/i.test(el.textContent.trim())) {
        let parent = el.parentElement;
        for (let depth = 0; depth < 3; depth++) {
          if (!parent) break;
          // 親要素が共通コンポーネントエリアに含まれる場合もスキップ
          if (parent.closest && parent.closest('header, footer, nav, menu, [class*="recommend" i]')) {
            break;
          }
          const parentText = parent.textContent.replace(/[,、]/g, "");
          const match = parentText.match(/(\d+)\s*ポイント/);
          if (match) {
            const val = parseInt(match[1], 10);
            if (val > 0 && val < 1000000) return val;
          }
          parent = parent.parentElement;
        }
      }
    }

    const pointSelectors = [
      ".bdg-point-display", 
      "#itemPoint", // 楽天ビックなどのVue/Nuxtバインド要素
      ".getPoint",
      ".point-firing",
      "[class*='point'] .important",
      "[class*='deal'] .important", 
      ".rakutenLimitedId_PointEarning",
      ".item-points",
      "#getPoint",
      ".spu-point",
      ".point-total",
    ];

    for (const selector of pointSelectors) {
      const el = this.doc.querySelector(selector);
      if (el) {
        // 共通コンポーネントエリアのスキップ
        if (el.closest && el.closest('header, footer, nav, menu, [class*="recommend" i]')) {
          continue;
        }
        const text = el.textContent.replace(/[,、]/g, "");
        const match = text.match(/(\d+)\s*ポイント/);
        if (match) return parseInt(match[1], 10);

        const numMatch = text.match(/\d+/);
        if (numMatch) {
          const num = parseInt(numMatch[0], 10);
          if (num > 0 && num < 1000000) return num;
        }
      }
    }

    const candidateElements = this.doc.querySelectorAll(
      "[class*='point'], [class*='Point'], [class*='deal'], [class*='Deal']"
    );
    for (const el of candidateElements) {
      // 共通コンポーネントエリアのスキップ
      if (el.closest && el.closest('header, footer, nav, menu, [class*="recommend" i]')) {
        continue;
      }
      if (el.children.length === 0 || (el.children.length === 1 && el.querySelector("span"))) {
        const text = el.textContent.replace(/[,、]/g, "").trim();
        const match = text.match(/^(\d+)\s*ポイント/);
        if (match) {
          const val = parseInt(match[1], 10);
          if (val > 0 && val < 1000000) return val;
        }
      }
    }

    const bodyText = this.doc.body ? this.doc.body.textContent.replace(/[,、]/g, "") : "";
    const pointPatterns = [
      /獲得予定ポイント[\s:：]*(\d+)/,
      /(\d+)\s*ポイント(?:獲得|進呈|付与)/,
      /(\d+)\s*ポイント\s*(?:内訳|[\(（])/ 
    ];

    for (const pattern of pointPatterns) {
      const match = bodyText.match(pattern);
      if (match) return parseInt(match[1], 10);
    }

    return 0;
  }

  /**
   * 楽天のクーポン表示から金額を抽出する
   */
  extractCoupon(currentPrice = 0) {
    const couponSelectors = [
      ".coupon-area",
      ".coupon",
      "[class*='coupon' i]",
      "[class*='racoupon' i]",
      "[class*='ra-coupon' i]",
      ".rakutenLimitedId_Coupon",
      ".item-coupon",
      "#coupon",
      ".shop-coupon",
      ".coupon-badge",
    ];

    const couponValues = [];

    for (const selector of couponSelectors) {
      try {
        const elements = this.doc.querySelectorAll(selector);
        for (const el of elements) {
          const text = el.textContent.replace(/[,、]/g, "");
          const minLimit = this.extractMinPurchaseLimit(text);
          if (minLimit > 0 && currentPrice > 0 && currentPrice < minLimit) continue;

          const matches = text.matchAll(/(\d+)\s*円\s*(?:OFF|off|オフ|引|クーポン|割引)/g);
          for (const match of matches) {
            couponValues.push(parseInt(match[1], 10));
          }
        }
      } catch (e) {}
    }

    if (this.doc.body) {
      const clone = this.doc.body.cloneNode(true);
      const excludedSelectors = [
        "script", "style", "#commonHeader", "#commonFooter", 
        "#grHeader", "#grFooter", "#partsHeader", "#partsFooter",
        ".shop-header", ".shopHeader"
      ];
      
      for (const sel of excludedSelectors) {
        try {
          const els = clone.querySelectorAll(sel);
          els.forEach(el => el.remove());
        } catch (e) {}
      }

      const bodyText = clone.textContent.replace(/[,、]/g, "");
      const couponPatterns = [
        /(\d+)\s*円\s*(?:OFF|off|オフ)\s*クーポン/gi,
        /クーポン[\s:：]*(\d+)\s*円/gi,
        /(\d+)\s*円\s*(?:OFF|off|オフ|引|引き|割引)/gi,
      ];

      for (const pattern of couponPatterns) {
        const matches = bodyText.matchAll(pattern);
        for (const match of matches) {
          const couponVal = parseInt(match[1], 10);
          const matchIndex = match.index;
          const start = Math.max(0, matchIndex - 50);
          const end = Math.min(bodyText.length, matchIndex + match[0].length + 50);
          const contextText = bodyText.slice(start, end);

          const minLimit = this.extractMinPurchaseLimit(contextText);
          if (minLimit > 0 && currentPrice > 0 && currentPrice < minLimit) continue;

          couponValues.push(couponVal);
        }
      }
    }

    return couponValues.length > 0 ? Math.max(...couponValues) : 0;
  }

  /**
   * 最低購入金額の抽出
   */
  extractMinPurchaseLimit(text) {
    if (!text) return 0;
    const cleanText = text.replace(/[,、]/g, "");
    const yenMatch = cleanText.match(/(\d+)\s*円以上/);
    if (yenMatch) return parseInt(yenMatch[1], 10);

    const manYenMatch = cleanText.match(/(\d+(?:\.\d+)?)\s*万円以上/);
    if (manYenMatch) return Math.floor(parseFloat(manYenMatch[1]) * 10000);

    return 0;
  }
}
