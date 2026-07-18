// ============================================================
// ResearchDeck - AmazonProvider (Amazon商品ページデータ抽出)
// Amazonの商品詳細ページからASINと価格などのデータを抽出します
// ============================================================

class AmazonProvider extends BaseProvider {
  constructor(doc = document) {
    super(doc);
    this.siteName = "Amazon.co.jp";
    this.pointsName = "還元ポイント";
    this.extraPointName = "その他還元";
    this.extraPointRateDefault = 0;
    this.dotClass = "rd-dot-market";
  }

  /**
   * データを抽出して共通オブジェクトを返す
   * @returns {Object} 共通データ構造
   */
  extractData() {
    const asin = this.extractAsin();
    const price = this.extractPrice();

    return {
      asin: asin,
      janCode: null, // SP-API結果から後で補完される
      price: price, // Amazonでの販売価格（初期値）
      points: 0,
      rawPoints: 0,
      coupon: 0,
      pointRate: 0,
      extraPointRate: 0,
      netCost: 0 // 最初は仕入れ値未入力のため実質 0
    };
  }

  /**
   * Amazonの商品詳細ページからASINを抽出
   * @returns {string|null} ASIN
   */
  extractAsin() {
    // 1. input#ASIN から取得
    const asinInput = this.doc.getElementById("ASIN") || this.doc.querySelector("input[name='ASIN']");
    if (asinInput && asinInput.value && asinInput.value.trim().length === 10) {
      return asinInput.value.trim();
    }

    // 2. URLから取得
    const match = this.doc.location.href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    if (match) {
      return match[1];
    }
    return null;
  }

  /**
   * Amazonの商品詳細ページから価格を抽出
   * @returns {number} 価格
   */
  extractPrice() {
    const priceSelectors = [
      "span.apexPriceToPay span.a-offscreen",
      "#price_inside_buybox",
      "#priceblock_ourprice",
      "#priceblock_dealprice",
      "span.a-price span.a-offscreen"
    ];
    for (const selector of priceSelectors) {
      const el = this.doc.querySelector(selector);
      if (el) {
        const text = el.textContent || "";
        const parsed = parseInt(text.replace(/[^0-9]/g, ""), 10);
        if (!isNaN(parsed) && parsed > 0) {
          return parsed;
        }
      }
    }
    return 0;
  }
}
