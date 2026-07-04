// ============================================================
// ResearchDeck - BaseProvider (共通データ抽出基底クラス)
// すべての仕入れサイトプロバイダーの基本構造と共通ロジックを定義します
// ============================================================

class BaseProvider {
  constructor(doc = document) {
    this.doc = doc;
    this.siteName = "共通仕入れ元";
    this.pointsName = "ポイント";
    this.extraPointName = "追加ポイント";
    this.extraPointRateDefault = 0;
    this.dotClass = "rd-dot-market";
  }

  /**
   * データを抽出して共通オブジェクトを返す
   * 子クラスで必ずオーバーライドします。
   * @returns {Object} 共通データ構造
   */
  extractData() {
    throw new Error("extractData() は子クラスで実装する必要があります");
  }

  /**
   * JANコードのチェックデジット検証（8桁または13桁）
   * 楽天の商品管理番号などの誤認識を防ぐために使用します。
   * @param {string} code - 判定対象 of 数値文字列
   * @returns {boolean} 正しいJANコードであればtrue
   */
  isValidJanCode(code) {
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
   * JSON-LD (構造化データ) から JANコードと価格を抽出する共通処理
   * @returns {Object|null} { jan, price } または null
   */
  extractFromJsonLd() {
    const jsonLdEls = this.doc.querySelectorAll('script[type="application/ld+json"]');
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
              if (match && this.isValidJanCode(match[0])) {
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
}
