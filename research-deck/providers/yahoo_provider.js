// ============================================================
// ResearchDeck - YahooProvider
// Yahoo!ショッピングの商品詳細ページからデータを抽出するプロバイダー
// ============================================================

class YahooProvider extends BaseProvider {
  constructor(doc = document) {
    super(doc);
    this.siteName = "Yahoo!ショッピング";
    this.pointsName = "PayPayポイント等";
    this.extraPointName = "追加ポイント";
    this.extraPointRateDefault = 0;
    this.dotClass = "rd-dot-yahoo";
  }

  /**
   * Yahoo!ショッピングの商品ページから全データを抽出する
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

    // 2. Next.jsの __NEXT_DATA__ からの抽出を試みる
    const nextDataEl = this.doc.getElementById("__NEXT_DATA__");
    if (nextDataEl) {
      try {
        const nextData = JSON.parse(nextDataEl.textContent);
        
        // 商品情報の場所をオブジェクトから再帰的に探索
        const itemInfo = this.findValInObj(nextData, "item");
        if (itemInfo) {
          // JANコード (gtin13, ean, janCode, jan)
          const gtin = itemInfo.gtin13 || itemInfo.ean || itemInfo.janCode || itemInfo.jan;
          if (gtin && this.isValidJanCode(gtin)) {
            janCode = gtin;
          }
          // 価格
          if (price === 0) {
            price = itemInfo.price || (itemInfo.priceWithoutTax ? Math.floor(itemInfo.priceWithoutTax * 1.1) : 0);
          }
        }
      } catch (e) {
        console.warn("ResearchDeck: __NEXT_DATA__のパースに失敗しました", e);
      }
    }

    // 3. DOMからのフォールバック抽出
    if (!janCode) {
      janCode = this.extractJanCode();
    }
    
    if (price === 0) {
      price = this.extractPrice();
    }

    // 獲得予定ポイントの抽出
    const domPoints = this.extractPoints();
    if (domPoints > 0) {
      points = domPoints;
    } else if (price > 0) {
      // ヤフショの基本ポイントは税抜に対して付与されるため、税抜価格の1%を仮定
      const taxExcludedPrice = Math.floor(price / 1.10);
      points = Math.floor(taxExcludedPrice * 0.01);
    }

    // クーポンの抽出（価格を基にパーセント引きも計算できるようにする）
    coupon = this.extractCoupon(price);

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
   * オブジェクト内を再帰探索して指定キーの値を見つけるヘルパー
   */
  findValInObj(obj, keyToFind) {
    if (!obj || typeof obj !== "object") return null;
    if (obj[keyToFind] !== undefined) return obj[keyToFind];
    
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const found = this.findValInObj(obj[key], keyToFind);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * JANコードの抽出
   */
  extractJanCode() {
    // 方法1: 商品仕様テーブルやスペック欄から「JAN」「JANコード」「商品コード」行を探す
    const specRows = this.doc.querySelectorAll(
      ".elSpecVal, .SpecVal, table tr, dl div, dt"
    );
    for (const el of specRows) {
      const text = el.textContent || "";
      if (/jan|ジャン|バーコード|商品コード/i.test(text)) {
        let parent = el.parentElement;
        if (parent) {
          const valMatch = parent.textContent.match(/\d{13}|\d{8}/);
          if (valMatch && this.isValidJanCode(valMatch[0])) return valMatch[0];
        }
      }
    }

    // 方法2: ページ全体のテキストからJANコードパターンを探す
    const bodyText = this.doc.body ? this.doc.body.textContent : "";
    const janPatterns = [
      /JAN(?:コード)?[\s:：\n\r]*(\d{13})/i,
      /JAN(?:コード)?[\s:：\n\r]*(\d{8})/i,
      /コード[\s:：\n\r]*(\d{13})/i,
    ];

    for (const pattern of janPatterns) {
      const match = bodyText.match(pattern);
      if (match && this.isValidJanCode(match[1])) return match[1];
    }

    // 13桁の独立した数値
    const allNumbers13 = bodyText.match(/\b\d{13}\b/g) || [];
    for (const num of allNumbers13) {
      if (this.isValidJanCode(num)) return num;
    }

    // 8桁の独立した数値
    const allNumbers8 = bodyText.match(/\b\d{8}\b/g) || [];
    for (const num of allNumbers8) {
      if (this.isValidJanCode(num)) return num;
    }

    // 方法3: URL末尾や商品ID自体がJANになっている場合のフォールバック
    const pathParts = window.location.pathname.split("/");
    const lastPart = pathParts[pathParts.length - 1];
    if (lastPart) {
      const idMatch = lastPart.replace(".html", "").match(/\d{13}|\d{8}/);
      if (idMatch && this.isValidJanCode(idMatch[0])) return idMatch[0];
    }

    return null;
  }

  /**
   * 価格（税込）の抽出
   */
  extractPrice() {
    // 1. メタタグ
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

    // 2. ヤフショ用の価格セレクタ
    const priceSelectors = [
      ".elPriceValue",         
      ".elPriceNumber",
      "[class*='PriceValue' i]",
      "[class*='PriceNumber' i]",
      ".price",
      ".item-price",
      'span[itemprop="price"]',
    ];

    for (const selector of priceSelectors) {
      const el = this.doc.querySelector(selector);
      if (el) {
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
   * 獲得PayPayポイントの抽出
   */
  extractPoints() {
    let totalPoints = 0;
    let hasFoundPoints = false;

    // 1. ページ全文からすべての空白・改行・カンマを排除し、キーワード周辺からpt付き数値を抽出
    if (this.doc.body) {
      // 全角半角スペース、改行、タブ、ノーブレークスペース(\u00a0)、カンマを完全に消去
      const text = this.doc.body.textContent
        .replace(/[,、]/g, "")
        .replace(/[\s\u00a0\t\r\n]/g, "");

      // 「今すぐ利用」のポイント数を厳密に狙い撃ち (例: 今すぐ利用5.5%(64pt) または 割り込み文字がある構造)
      const immediateMatch = text.match(/今すぐ利用[^a-zA-Z0-9]*?(?:\d+(?:\.\d+)?%)?\(?(\d+)(?:pt|ポイント|円相当)/i);
      let immediatePoints = 0;
      if (immediateMatch) {
        immediatePoints = parseInt(immediateMatch[1], 10);
        totalPoints += immediatePoints;
        hasFoundPoints = true;
        console.log("ResearchDeck: 「今すぐ利用」を検出:", immediatePoints);
      }

      // 「獲得」のポイント数を厳密に狙い撃ち (例: 獲得後日付与1.5%(17pt) のような割り込み文字がある構造)
      const afterMatch = text.match(/獲得[^a-zA-Z0-9]*?(?:\d+(?:\.\d+)?%)?\(?(\d+)(?:pt|ポイント|円相当)/i);
      let afterPoints = 0;
      if (afterMatch) {
        afterPoints = parseInt(afterMatch[1], 10);
        totalPoints += afterPoints;
        hasFoundPoints = true;
        console.log("ResearchDeck: 「獲得」を検出:", afterPoints);
      }

      // 右側サイドバーなどの「X%獲得(Ypt)」の記述を、獲得側が0だった場合のフォールバックで検索
      if (afterPoints === 0) {
        const sidebarMatch = text.match(/\d+(?:\.\d+)?%獲得\(?(\d+)(?:pt|ポイント)/i);
        if (sidebarMatch) {
          const sidebarPoints = parseInt(sidebarMatch[1], 10);
          totalPoints += sidebarPoints;
          hasFoundPoints = true;
          console.log("ResearchDeck: 「%獲得」を検出:", sidebarPoints);
        }
      }
    }

    if (hasFoundPoints && totalPoints > 0) {
      console.log(`ResearchDeck: ヤフショ「今すぐ利用＋獲得」ポイントの自動合計に成功: ${totalPoints}pt`);
      return totalPoints;
    }

    // --- 従来のフォールバック抽出 ---
    // 「内訳」周辺からの抽出（最も頑健）
    const allElements = this.doc.getElementsByTagName("*");
    for (const el of allElements) {
      if (el.textContent && /^(内訳|ポイントの内訳|PayPayの内訳)$/i.test(el.textContent.trim())) {
        let parent = el.parentElement;
        for (let depth = 0; depth < 4; depth++) {
          if (!parent) break;
          const parentText = parent.textContent.replace(/[,、]/g, "");
          const match = parentText.match(/(\d+)\s*(?:ポイント|円相当|円分)/);
          if (match) {
            const val = parseInt(match[1], 10);
            if (val > 0 && val < 1000000) return val;
          }
          parent = parent.parentElement;
        }
      }
    }

    // セレクタによる抽出
    const pointSelectors = [
      ".elItemGrandPoint",
      ".elPointCount",
      "[class*='GrandPoint' i]",
      "[class*='PointCount' i]",
      "[class*='PointDisplay' i]",
    ];

    for (const selector of pointSelectors) {
      const el = this.doc.querySelector(selector);
      if (el) {
        const text = el.textContent.replace(/[,、]/g, "");
        const match = text.match(/(\d+)\s*(?:ポイント|円相当|円分)/);
        if (match) return parseInt(match[1], 10);

        const numMatch = text.match(/\d+/);
        if (numMatch) {
          const num = parseInt(numMatch[0], 10);
          if (num > 0 && num < 1000000) return num;
        }
      }
    }

    return 0;
  }

  /**
   * クーポンの抽出（%割引にも対応）
   */
  extractCoupon(currentPrice = 0) {
    const couponSelectors = [
      ".elItemCoupon",
      ".elCoupon",
      ".shop-coupon",
      ".coupon-badge",
      "[class*='coupon' i]"
    ];

    const couponValues = [];

    for (const selector of couponSelectors) {
      try {
        const elements = this.doc.querySelectorAll(selector);
        for (const el of elements) {
          // ヘッダー、フッター、ナビゲーション、メニュー、サイドバー等の共通・広告エリアにあるものは除外
          if (el.closest("header, footer, nav, [class*='header' i], [class*='footer' i], [class*='menu' i], #commonHeader, #commonFooter, #ycgheader, #ycgfooter")) {
            continue;
          }

          const text = el.textContent.replace(/[,、]/g, "");
          const minLimit = this.extractMinPurchaseLimit(text);
          if (minLimit > 0 && currentPrice > 0 && currentPrice < minLimit) continue;

          // 1. 円引きクーポンの判定 (例: 500円OFF, 500円引き)
          const yenMatches = text.matchAll(/(\d+)\s*円\s*(?:OFF|off|オフ|引|クーポン|割引)/g);
          for (const match of yenMatches) {
            couponValues.push(parseInt(match[1], 10));
          }

          // 2. %引きクーポンの判定 (例: 5%OFF, 10%引き)
          const percentMatches = text.matchAll(/(\d+)\s*%\s*(?:OFF|off|オフ|引|クーポン|割引)/g);
          for (const match of percentMatches) {
            const pct = parseInt(match[1], 10);
            if (pct > 0 && pct <= 100 && currentPrice > 0) {
              const discount = Math.floor(currentPrice * (pct / 100));
              couponValues.push(discount);
            }
          }
        }
      } catch (e) {}
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
