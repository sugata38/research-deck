// ============================================================
// ResearchDeck - 月間販売数推定ロジック
// BSR（ベストセラーランキング）とカテゴリから
// 月間の販売個数を推定する計算モジュール
// ============================================================

/**
 * Amazon.co.jp のカテゴリごとの推定係数テーブル
 *
 * 推定式: 月間販売数 ≈ coefficient × BSR^(-exponent)
 *
 * この式は対数関数ベースの近似で、業界標準的なアプローチ。
 * 係数はカテゴリごとの市場規模（総商品数・総売上）に依存する。
 * ※値はあくまで概算。実際の販売数とは±20%程度の誤差がある前提。
 *
 * categoryId はAmazonの内部カテゴリ番号（browse node ID）の
 * 上位分類に対応している。SP-APIから取得できるカテゴリ名で照合する。
 */
const CATEGORY_COEFFICIENTS = {
  // --- 大規模カテゴリ（商品数が非常に多い） ---
  "ホーム＆キッチン": { coefficient: 120000, exponent: 0.82 },
  "Home & Kitchen": { coefficient: 120000, exponent: 0.82 },

  "ドラッグストア": { coefficient: 100000, exponent: 0.80 },
  "Health & Beauty": { coefficient: 100000, exponent: 0.80 },

  "ビューティー": { coefficient: 90000, exponent: 0.80 },
  "Beauty": { coefficient: 90000, exponent: 0.80 },

  "食品・飲料・お酒": { coefficient: 85000, exponent: 0.79 },
  "Grocery": { coefficient: 85000, exponent: 0.79 },

  // --- 中規模カテゴリ ---
  "家電&カメラ": { coefficient: 80000, exponent: 0.80 },
  "Electronics": { coefficient: 80000, exponent: 0.80 },

  "パソコン・周辺機器": { coefficient: 70000, exponent: 0.79 },
  "Computers": { coefficient: 70000, exponent: 0.79 },

  "スポーツ&アウトドア": { coefficient: 75000, exponent: 0.80 },
  "Sports & Outdoors": { coefficient: 75000, exponent: 0.80 },

  "おもちゃ": { coefficient: 80000, exponent: 0.81 },
  "Toys & Games": { coefficient: 80000, exponent: 0.81 },

  "ペット用品": { coefficient: 65000, exponent: 0.78 },
  "Pet Supplies": { coefficient: 65000, exponent: 0.78 },

  "DIY・工具・ガーデン": { coefficient: 60000, exponent: 0.78 },
  "Tools & Home Improvement": { coefficient: 60000, exponent: 0.78 },

  "ベビー&マタニティ": { coefficient: 55000, exponent: 0.78 },
  "Baby": { coefficient: 55000, exponent: 0.78 },

  "車&バイク": { coefficient: 55000, exponent: 0.77 },
  "Automotive": { coefficient: 55000, exponent: 0.77 },

  "文房具・オフィス用品": { coefficient: 50000, exponent: 0.77 },
  "Office Products": { coefficient: 50000, exponent: 0.77 },

  // --- 小規模カテゴリ ---
  "本": { coefficient: 200000, exponent: 0.85 },
  "Books": { coefficient: 200000, exponent: 0.85 },

  "ミュージック": { coefficient: 40000, exponent: 0.78 },
  "Music": { coefficient: 40000, exponent: 0.78 },

  "DVD": { coefficient: 40000, exponent: 0.78 },

  "ゲーム": { coefficient: 50000, exponent: 0.78 },
  "Video Games": { coefficient: 50000, exponent: 0.78 },

  "楽器・音響機器": { coefficient: 35000, exponent: 0.76 },
  "Musical Instruments": { coefficient: 35000, exponent: 0.76 },

  "産業・研究開発用品": { coefficient: 30000, exponent: 0.75 },
  "Industrial & Scientific": { coefficient: 30000, exponent: 0.75 },

  "腕時計": { coefficient: 30000, exponent: 0.75 },
  "Watches": { coefficient: 30000, exponent: 0.75 },

  "ジュエリー": { coefficient: 25000, exponent: 0.74 },
  "Jewelry": { coefficient: 25000, exponent: 0.74 },

  "シューズ&バッグ": { coefficient: 45000, exponent: 0.77 },
  "Shoes & Bags": { coefficient: 45000, exponent: 0.77 },

  "服&ファッション小物": { coefficient: 60000, exponent: 0.78 },
  "Clothing": { coefficient: 60000, exponent: 0.78 },

  "大型家電": { coefficient: 20000, exponent: 0.73 },
  "Large Appliances": { coefficient: 20000, exponent: 0.73 },
};

/**
 * どのカテゴリにも該当しない場合のデフォルト係数
 * 中規模カテゴリの平均的な値を使用
 */
const DEFAULT_COEFFICIENTS = { coefficient: 60000, exponent: 0.78 };

/**
 * カテゴリ名からランキング係数を取得する
 * SP-APIから返されるカテゴリ名を部分一致で照合する
 *
 * @param {string} categoryName - SP-APIから取得したカテゴリ名
 * @returns {Object} { coefficient, exponent } の係数オブジェクト
 */
function getCategoryCoefficients(categoryName) {
  if (!categoryName) return DEFAULT_COEFFICIENTS;

  // 完全一致を最優先で検索
  if (CATEGORY_COEFFICIENTS[categoryName]) {
    return CATEGORY_COEFFICIENTS[categoryName];
  }

  // 部分一致で検索（SP-APIのカテゴリ名が微妙に異なる場合の対応）
  const normalizedName = categoryName.toLowerCase();
  for (const [key, value] of Object.entries(CATEGORY_COEFFICIENTS)) {
    if (normalizedName.includes(key.toLowerCase()) || key.toLowerCase().includes(normalizedName)) {
      return value;
    }
  }

  // どれにも該当しなければデフォルト値を返す
  return DEFAULT_COEFFICIENTS;
}

/**
 * BSRとカテゴリから月間販売個数を推定する
 *
 * 推定式: 月間販売数 ≈ coefficient × BSR^(-exponent)
 *
 * 例: ホーム＆キッチンでBSR 1,000位の場合
 *     120000 × 1000^(-0.82) ≈ 約274個/月
 *
 * @param {number} bsr - ベストセラーランキング（順位）
 * @param {string} categoryName - Amazonのカテゴリ名
 * @returns {Object} { estimatedMonthlySales, confidence, categoryUsed }
 */
function estimateMonthlySales(bsr, categoryName) {
  // BSRが無効な場合は推定不可
  if (!bsr || bsr <= 0) {
    return {
      estimatedMonthlySales: null,
      confidence: "推定不可",
      categoryUsed: categoryName || "不明",
    };
  }

  const coefficients = getCategoryCoefficients(categoryName);

  // 对数ベースの推定計算
  const rawEstimate = coefficients.coefficient * Math.pow(bsr, -coefficients.exponent);

  // 悲観的バッファ（20%削減）を適用し、安全に見積もる
  const pessimisticEstimate = rawEstimate * 0.8;

  // 小数点以下を切り捨て（より厳しい悲観的な見積もり）、最低値を0個とする（売れない商品は0個と表示）
  const estimatedMonthlySales = Math.max(0, Math.floor(pessimisticEstimate));

  // 信頼度の判定
  // BSRが低い（上位）ほど推定精度が高い傾向がある
  let confidence;
  if (estimatedMonthlySales === 0) {
    confidence = "仕入れ対象外（月販0個予測）";
  } else if (bsr <= 1000) {
    confidence = "高";
  } else if (bsr <= 10000) {
    confidence = "中";
  } else if (bsr <= 100000) {
    confidence = "低";
  } else {
    confidence = "参考値";
  }

  // デフォルト係数を使ったかどうかの情報
  const usedDefault = coefficients === DEFAULT_COEFFICIENTS;

  return {
    estimatedMonthlySales,
    confidence,
    categoryUsed: categoryName || "汎用（デフォルト）",
    isDefaultCategory: usedDefault,
  };
}
