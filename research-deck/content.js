// ============================================================
// ResearchDeck - Content Script
// 各ショッピングサイトから情報を抽出し、
// SP-API経由でAmazonの利益・出品可否・販売数を表示するツール
// ============================================================

// コピー用SVGアイコン
const COPY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; display: inline-block; margin-left: 2px;"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;

// グローバルスコープでの状態管理変数
let currentAmazonData = null;
let currentAutoCoupon = 0;
let currentAutoExtraRate = 0;
let provider = null; // 現在のショッピングサイト用プロバイダーのインスタンス

// ============================================================
// 1. プロバイダーの初期化
// ============================================================
function initProvider() {
  const hostname = window.location.hostname;
  if (hostname.includes("rakuten.co.jp")) {
    provider = new RakutenProvider(document);
  } else if (hostname.includes("yahoo.co.jp")) {
    provider = new YahooProvider(document);
  } else {
    // 予期しないサイト用のフォールバック（item-page-app-dataがあるかで楽天と判定）
    if (document.getElementById("item-page-app-data") || document.querySelector(".item-price, .primary--2kjQA")) {
      provider = new RakutenProvider(document);
    } else {
      provider = new BaseProvider(document); // 動作しないダミー
    }
  }
  console.log(`ResearchDeck: プロバイダーを初期化しました -> ${provider.siteName}`);
}

// ============================================================
// 2. 利益計算
// ============================================================

/**
 * 利益を計算する
 * 粗利益 = Amazon販売価格 - FBA手数料合計 - 実質仕入れ値
 */
function calculateProfit(amazonPrice, totalFees, netCost) {
  if (!amazonPrice || amazonPrice <= 0) {
    return { profit: null, profitRate: null };
  }

  const profit = amazonPrice - totalFees - netCost;
  const profitRate = (profit / amazonPrice) * 100;

  return {
    profit: Math.round(profit),
    profitRate: Math.round(profitRate * 10) / 10,
  };
}

// ============================================================
// 3. UIの描画（ダッシュボードモーダル）
// ============================================================

/**
 * FBA月間保管手数料の計算内訳からツールチップに表示するテキストを生成する
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
 */
function formatNumber(num) {
  if (num === null || num === undefined) return "---";
  return num.toLocaleString("ja-JP");
}

/**
 * 消費税を除いた税抜価格を計算する
 * 食品・飲料の場合は8%軽減税率、その他は10%標準税率で逆算
 */
function calculateTaxExcludedPrice(price, categoryName) {
  if (!price || price <= 0) return 0;

  // 食品・飲料系カテゴリの判定キーワード（楽天・ヤフショ両方に対応）
  const isFoodOrBeverage = categoryName && 
    (categoryName.includes("食品") || 
     categoryName.includes("飲料") || 
     categoryName.includes("お酒") || 
     categoryName.includes("水") || 
     categoryName.includes("お茶") || 
     categoryName.includes("ドリンク") || 
     categoryName.includes("Grocery") || 
     categoryName.includes("食品・飲料・お酒") ||
     categoryName.includes("食品、ドリンク、お酒") ||
     categoryName.includes("グルメ"));
  
  const taxRate = isFoodOrBeverage ? 0.08 : 0.10;
  return Math.floor(price / (1 + taxRate));
}

/**
 * 出品ステータスのバッジHTMLを生成する
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
 */
function renderDashboard(shopData, amazonData) {
  const existing = document.getElementById("rd-dashboard");
  if (existing) existing.remove();

  const dashboard = document.createElement("div");
  dashboard.id = "rd-dashboard";

  // --- Amazonセクションの構築 ---
  let amazonSectionHtml = "";

  if (amazonData) {
    const profitData = calculateProfit(
      amazonData.amazonPrice,
      amazonData.totalFees,
      shopData.netCost
    );

    const profitClass = profitData.profit !== null
      ? (profitData.profit >= 0 ? "rd-profit-positive" : "rd-profit-negative")
      : "";

    const profitRateClass = profitData.profitRate !== null
      ? (profitData.profitRate >= 0 ? "rd-profit-positive" : "rd-profit-negative")
      : "";

    const amazonErrorHtml = (amazonData.error || amazonData.pricingError)
      ? `<div class="rd-alert rd-alert-info" style="margin-top: 8px; border-color: #f0ddb8; background-color: #fdf5e6; color: #8b6914;">
           <span class="rd-alert-icon">⚠️</span>
           <span>${amazonData.error === "PRODUCT_NOT_FOUND"
             ? "Amazon上に該当商品が見つかりませんでした"
             : `価格取得エラー: ${amazonData.error || amazonData.pricingError}`}</span>
         </div>`
      : "";

    const restrictionReasonsHtml = (amazonData.restrictionReasons && amazonData.restrictionReasons.length > 0)
      ? `<div class="rd-restriction-reasons" style="margin-top: 4px;">
           ${amazonData.restrictionReasons.map(r => `<span class="rd-restriction-reason">${r}</span>`).join("")}
         </div>`
      : "";

    amazonSectionHtml = `
      <!-- 出品ステータスセクション -->
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
            <span class="rd-data-value rd-text-fee" id="rd-amazon-net-cost">-¥${formatNumber(shopData.netCost)}</span>
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

  // JAN/ASINの各種外部検索リンクURLを構築
  const extSearchJan = shopData.janCode || '';
  const searchButtonsHtml = extSearchJan ? `
    <a href="https://search.rakuten.co.jp/search/mall/${extSearchJan}/" target="_blank" rel="noopener noreferrer" class="rd-link-btn rd-link-btn-rakuten" title="楽天市場でJAN検索">楽天 ↗</a>
    <a href="https://shopping.yahoo.co.jp/search?p=${extSearchJan}" target="_blank" rel="noopener noreferrer" class="rd-link-btn rd-link-btn-yahoo" title="Yahoo!ショッピングでJAN検索">ヤフ ↗</a>
  ` : '';

  // ドットの色（ショップごとに変更）
  const shopDotClass = provider.dotClass;

  // ダッシュボードのHTML構造
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
          <span class="rd-identifier-value" id="rd-copy-jan" title="クリックでコピー" data-copy="${extSearchJan}">
            ${extSearchJan || '<span style="color: #b44a3a; font-size: 9.5px; font-family: inherit; font-weight: 700; white-space: nowrap;" title="JANコードが見つかりませんでした。ページ読み込み完了後に、右上の更新ボタン（🔄）を押して再取得してください。">⚠️ 未検出 (🔄更新)</span>'}
            ${extSearchJan ? `<span class="rd-copy-icon">${COPY_ICON_SVG}</span>` : ''}
          </span>
          <div class="rd-identifier-buttons">
            ${searchButtonsHtml}
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

      <!-- ショップセクション -->
      <div class="rd-section">
        <div class="rd-section-header">
          <span class="rd-section-dot ${shopDotClass}"></span>
          <span class="rd-section-title">${provider.siteName}</span>
        </div>
        <div class="rd-data-grid">
          <div class="rd-data-row">
            <span class="rd-data-label">価格（税込）</span>
            <span class="rd-data-value" id="rd-rakuten-price">¥${formatNumber(shopData.price)}</span>
          </div>
          <div class="rd-data-row">
            <span class="rd-data-label">${provider.pointsName}</span>
            <span class="rd-data-value rd-text-accent" id="rd-rakuten-points">${formatNumber(Math.abs(shopData.points))}pt</span>
          </div>
          <div class="rd-data-row" style="flex-wrap: wrap;">
            <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
              <span class="rd-data-label">${provider.extraPointName} (%)</span>
              <span class="rd-data-value" style="display: flex; align-items: center; gap: 4px;">
                <div class="rd-spinner-container">
                  <button class="rd-spinner-btn" id="rd-extra-point-minus" type="button">−</button>
                  <input type="number" id="rd-input-extra-point" min="0" max="100" step="1" value="${shopData.extraPointRate || 0}" class="rd-number-input" title="ポイント付与対象である「税抜価格」を基準に計算します" />
                  <button class="rd-spinner-btn" id="rd-extra-point-plus" type="button">+</button>
                </div>
                <span>%</span>
              </span>
            </div>
            <div style="width: 100%; text-align: right; margin-top: 2px;">
              <span id="rd-tax-excluded-info" style="font-size: 10px; color: #b0aaa3;">(税抜価格 ¥${formatNumber(shopData.taxExcludedPrice)} に対して : <span id="rd-extra-points-display" style="color: #6b7f94; font-weight: 700;">${formatNumber(Math.abs(shopData.extraPoints || 0))}</span>pt)</span>
            </div>
          </div>
          <div class="rd-data-row">
            <span class="rd-data-label">クーポン (¥)</span>
            <span class="rd-data-value rd-text-accent" style="display: flex; align-items: center; gap: 4px;">
              <span>-¥</span>
              <div class="rd-spinner-container">
                <button class="rd-spinner-btn" id="rd-coupon-minus" type="button">−</button>
                <input type="number" id="rd-input-coupon" min="0" step="100" value="${shopData.coupon || 0}" class="rd-number-input" title="クーポン割引金額を手動で調整できます" />
                <button class="rd-spinner-btn" id="rd-coupon-plus" type="button">+</button>
              </div>
            </span>
          </div>
          <div class="rd-divider"></div>
          <div class="rd-data-row rd-highlight-row">
            <span class="rd-data-label rd-text-bold">実質仕入れ値</span>
            <span class="rd-data-value rd-net-cost" id="rd-rakuten-net-cost">¥${formatNumber(shopData.netCost)}</span>
          </div>
        </div>
      </div>

      ${amazonSectionHtml}
    </div>
  `;

  document.body.appendChild(dashboard);

  // ドラッグ位置の復元
  const savedTop = localStorage.getItem("rd-dashboard-top");
  const savedLeft = localStorage.getItem("rd-dashboard-left");
  if (savedTop !== null && savedLeft !== null) {
    dashboard.style.top = savedTop;
    dashboard.style.left = savedLeft;
    dashboard.style.right = "auto";
  }

  // 各種イベントリスナーの設定
  const refreshBtn = document.getElementById("rd-refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      refreshBtn.classList.add("rd-disabled");

      try {
        const newShopData = provider.extractData();
        newShopData.extraPointRate = provider.extraPointRateDefault;
        const pageTitle = document.title || "";
        const isLikelyFood = /お茶|水|炭酸|飲料|食品|グルメ|スイーツ|ビール|酒/i.test(pageTitle);
        const initialTaxRate = isLikelyFood ? 0.08 : 0.10;
        const discountedPrice = Math.max(0, newShopData.price - newShopData.coupon);
        newShopData.taxExcludedPrice = Math.floor(discountedPrice / (1 + initialTaxRate));
        
        const discountedPoints = newShopData.price > 0 
          ? Math.floor(newShopData.rawPoints * (discountedPrice / newShopData.price)) 
          : 0;
        newShopData.points = discountedPoints;

        const extraPoints = Math.floor(newShopData.taxExcludedPrice * (provider.extraPointRateDefault / 100));
        newShopData.extraPoints = Math.abs(extraPoints);
        newShopData.netCost = newShopData.price - discountedPoints - Math.abs(extraPoints) - newShopData.coupon;
        
        if (newShopData.janCode) {
          await fetchAndRenderAmazonData(newShopData);
        } else {
          renderDashboard(newShopData, null);
        }
      } catch (err) {
        console.error("ResearchDeck: リフレッシュ中にエラーが発生しました -", err);
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove("rd-disabled");
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


    const discountedPrice = Math.max(0, shopData.price - couponValue);
    const discountedPoints = shopData.price > 0 
      ? Math.floor(shopData.rawPoints * (discountedPrice / shopData.price)) 
      : 0;

    const pointsDisplayEl = document.getElementById("rd-rakuten-points");
    if (pointsDisplayEl) {
      pointsDisplayEl.textContent = `${formatNumber(discountedPoints)}pt`;
    }

    const categoryName = (currentAmazonData && currentAmazonData.categoryName) || "";
    const taxExcludedPrice = calculateTaxExcludedPrice(discountedPrice, categoryName);
    const extraPoints = Math.floor(taxExcludedPrice * (extraPointRate / 100));

    const taxExcludedInfoEl = document.getElementById("rd-tax-excluded-info");
    if (taxExcludedInfoEl) {
      taxExcludedInfoEl.innerHTML = `(税抜価格 ¥${formatNumber(taxExcludedPrice)} に対して : <span id="rd-extra-points-display" style="color: #6b7f94; font-weight: 700;">${formatNumber(Math.abs(extraPoints))}</span>pt)`;
    }

    const netCost = shopData.price - discountedPoints - Math.abs(extraPoints) - couponValue;
    const shopNetCostEl = document.getElementById("rd-rakuten-net-cost");
    if (shopNetCostEl) shopNetCostEl.textContent = `¥${formatNumber(netCost)}`;
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

  // カスタムスピンボタンのクリックイベントを設定
  const extraMinus = document.getElementById("rd-extra-point-minus");
  const extraPlus = document.getElementById("rd-extra-point-plus");
  if (extraMinus && extraPlus && extraPointInput) {
    extraMinus.addEventListener("click", () => {
      const val = Math.max(0, parseInt(extraPointInput.value || 0, 10) - 1);
      extraPointInput.value = val;
      updateCalculations();
    });
    extraPlus.addEventListener("click", () => {
      const val = Math.min(100, parseInt(extraPointInput.value || 0, 10) + 1);
      extraPointInput.value = val;
      updateCalculations();
    });
  }

  const couponMinus = document.getElementById("rd-coupon-minus");
  const couponPlus = document.getElementById("rd-coupon-plus");
  if (couponMinus && couponPlus && couponInput) {
    couponMinus.addEventListener("click", () => {
      const val = Math.max(0, parseInt(couponInput.value || 0, 10) - 100);
      couponInput.value = val;
      updateCalculations();
    });
    couponPlus.addEventListener("click", () => {
      const val = parseInt(couponInput.value || 0, 10) + 100;
      couponInput.value = val;
      updateCalculations();
    });
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

/**
 * SP-APIからAmazonデータを非同期で取得し、ダッシュボードを更新・再描画する
 */
async function fetchAndRenderAmazonData(shopData) {
  showAmazonLoading();
  try {
    const result = await chrome.runtime.sendMessage({
      type: "FETCH_AMAZON_DATA",
      janCode: shopData.janCode,
    });
    
    removeAmazonLoading();
    
    if (result && result.success && result.data) {
      const discountedPrice = Math.max(0, shopData.price - shopData.coupon);
      shopData.taxExcludedPrice = calculateTaxExcludedPrice(discountedPrice, result.data.categoryName);
      
      const discountedPoints = shopData.price > 0 
        ? Math.floor(shopData.rawPoints * (discountedPrice / shopData.price)) 
        : 0;
      shopData.points = discountedPoints; 

      shopData.extraPointRate = provider.extraPointRateDefault;
      const extraPoints = Math.floor(shopData.taxExcludedPrice * (provider.extraPointRateDefault / 100));
      shopData.extraPoints = Math.abs(extraPoints);
      shopData.netCost = shopData.price - discountedPoints - Math.abs(extraPoints) - shopData.coupon;
      
      currentAmazonData = result.data;
      renderDashboard(shopData, result.data);
    } else {
      console.warn("ResearchDeck: Amazonデータの取得に失敗しました。", result ? result.error : "");
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
      renderDashboard(shopData, errorData);
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
    renderDashboard(shopData, exceptionData);
  }
}

/**
 * 詳細ページでの統合初期化処理
 */
async function initializeDetailPage() {
  console.log("ResearchDeck: 詳細ページの初期化を開始します...");

  // プロバイダーからデータを抽出
  const shopData = provider.extractData();
  
  shopData.extraPointRate = provider.extraPointRateDefault;
  
  const initialDiscountedPrice = Math.max(0, shopData.price - shopData.coupon);
  const initialDiscountedPoints = shopData.price > 0 
    ? Math.floor(shopData.rawPoints * (initialDiscountedPrice / shopData.price)) 
    : 0;
  shopData.points = initialDiscountedPoints; 

  const pageTitle = document.title || "";
  const isLikelyFood = /お茶|水|炭酸|飲料|食品|グルメ|スイーツ|ビール|酒/i.test(pageTitle);
  const initialTaxRate = isLikelyFood ? 0.08 : 0.10;
  shopData.taxExcludedPrice = Math.floor(initialDiscountedPrice / (1 + initialTaxRate));

  const extraPoints = Math.floor(shopData.taxExcludedPrice * (provider.extraPointRateDefault / 100));
  shopData.extraPoints = Math.abs(extraPoints);
  shopData.netCost = shopData.price - initialDiscountedPoints - Math.abs(extraPoints) - shopData.coupon;

  console.log("ResearchDeck: 抽出結果", shopData);

  currentAutoCoupon = shopData.coupon;
  currentAutoExtraRate = provider.extraPointRateDefault;
  currentAmazonData = null;

  // まずショップデータのみで描画
  renderDashboard(shopData, null);

  // JANコードがある場合はAmazonデータ取得へ
  if (shopData.janCode && provider.isValidJanCode(shopData.janCode)) {
    await fetchAndRenderAmazonData(shopData);
  } else {
    console.log("ResearchDeck: 正しいJANコードが検出されませんでした。");
    shopData.janCode = null;
    renderDashboard(shopData, null);
  }

  // 非同期読み込みのための自動ポーリング
  const pollIntervals = [1500, 3000, 5000, 10000];
  pollIntervals.forEach(delay => {
    setTimeout(async () => {
      console.log(`ResearchDeck: 自動再スキャンを実行します (${delay}ms)...`);
      const newData = provider.extractData();
      let updated = false;

      const couponInput = document.getElementById("rd-input-coupon");
      const currentCouponVal = couponInput ? parseInt(couponInput.value || 0, 10) : shopData.coupon;

      if (newData.coupon !== currentAutoCoupon && currentCouponVal === currentAutoCoupon) {
        console.log(`ResearchDeck: クーポン値が更新されました: ${currentAutoCoupon} -> ${newData.coupon}`);
        shopData.coupon = newData.coupon;
        currentAutoCoupon = newData.coupon;
        updated = true;
      }

      if (!shopData.janCode && newData.janCode && provider.isValidJanCode(newData.janCode)) {
        console.log(`ResearchDeck: JANコードが新しく検出されました: ${newData.janCode}`);
        shopData.janCode = newData.janCode;
        updated = true;
      }

      if (shopData.price === 0 && newData.price > 0) {
        console.log(`ResearchDeck: 価格が新しく検出されました: ${newData.price}`);
        shopData.price = newData.price;
        shopData.points = newData.points || Math.floor(newData.price * 0.01);
        
        const pageTitle = document.title || "";
        const isLikelyFood = /お茶|水|炭酸|飲料|食品|グルメ|スイーツ|ビール|酒/i.test(pageTitle);
        const initialTaxRate = isLikelyFood ? 0.08 : 0.10;
        const discountedPrice = Math.max(0, shopData.price - shopData.coupon);
        shopData.taxExcludedPrice = Math.floor(discountedPrice / (1 + initialTaxRate));
        updated = true;
      }

      if (newData.rawPoints !== shopData.rawPoints && newData.rawPoints > 0) {
        console.log(`ResearchDeck: ポイント値が更新されました: ${shopData.rawPoints} -> ${newData.rawPoints}`);
        shopData.rawPoints = newData.rawPoints;
        updated = true;
      }

      if (updated) {
        const categoryName = (currentAmazonData && currentAmazonData.categoryName) || "";
        const discountedPrice = Math.max(0, shopData.price - shopData.coupon);
        shopData.taxExcludedPrice = calculateTaxExcludedPrice(discountedPrice, categoryName);

        const discountedPoints = shopData.price > 0 
          ? Math.floor(shopData.rawPoints * (discountedPrice / shopData.price)) 
          : 0;
        shopData.points = discountedPoints;

        shopData.extraPointRate = provider.extraPointRateDefault;
        const extraPoints = Math.floor(shopData.taxExcludedPrice * (provider.extraPointRateDefault / 100));
        shopData.extraPoints = Math.abs(extraPoints);
        shopData.netCost = shopData.price - discountedPoints - Math.abs(extraPoints) - shopData.coupon;

        if (shopData.janCode && (!currentAmazonData || currentAmazonData.error)) {
          await fetchAndRenderAmazonData(shopData);
        } else {
          // チラつき防止ピンポイント更新
          const couponInput = document.getElementById("rd-input-coupon");
          if (couponInput) {
            couponInput.value = shopData.coupon;

            const priceEl = document.getElementById("rd-rakuten-price");
            if (priceEl) priceEl.textContent = `¥${formatNumber(shopData.price)}`;

            const pointsEl = document.getElementById("rd-rakuten-points");
            if (pointsEl) pointsEl.textContent = `${formatNumber(Math.abs(shopData.points))}pt`;

            const taxExcludedInfoEl = document.getElementById("rd-tax-excluded-info");
            if (taxExcludedInfoEl) {
              const currentExtraPoints = Math.floor(shopData.taxExcludedPrice * (shopData.extraPointRate / 100));
              taxExcludedInfoEl.innerHTML = `(税抜価格 ¥${formatNumber(shopData.taxExcludedPrice)} に対して : <span id="rd-extra-points-display" style="color: #6b7f94; font-weight: 700;">${formatNumber(Math.abs(currentExtraPoints))}</span>pt)`;
            }

            const janCopyEl = document.getElementById("rd-copy-jan");
            if (janCopyEl && shopData.janCode && !janCopyEl.getAttribute("data-copy")) {
              janCopyEl.setAttribute("data-copy", shopData.janCode);
              janCopyEl.innerHTML = `${shopData.janCode} <span class="rd-copy-icon">${COPY_ICON_SVG}</span>`;
            }

            couponInput.dispatchEvent(new Event("input"));
          } else {
            renderDashboard(shopData, currentAmazonData);
          }
        }
      }
    }, delay);
  });
}

// ============================================================
// メイン実行処理
// ============================================================
(async () => {
  try {
    initProvider();
    
    // 詳細ページ判定（ドメインが楽天またはヤフーショッピングのストアであること）
    const hostname = window.location.hostname;
    const isRakutenDetail = hostname.includes("item.rakuten.co.jp");
    
    let isYahooStoreDetail = hostname.includes("store.shopping.yahoo.co.jp");
    if (isYahooStoreDetail) {
      const path = window.location.pathname;
      const pathParts = path.split("/").filter(p => p);
      
      // Yahoo!ショッピングの個別商品詳細ページは通常 /ストア名/商品ID.html の構造 (パーツ数が2で末尾が.html)
      // ストアトップや search.html などのシステムページは除外する
      if (pathParts.length !== 2) {
        isYahooStoreDetail = false;
      } else {
        const lastPart = pathParts[1];
        const isSystemPage = /^(search|info|custom|news|calendar|index|category|guide)\.html$/i.test(lastPart);
        const isHtml = lastPart.endsWith(".html");
        if (isSystemPage || !isHtml) {
          isYahooStoreDetail = false;
        }
      }
    }
    
    if (!isRakutenDetail && !isYahooStoreDetail) {
      console.log("ResearchDeck: 対象のショップ詳細ページではないため起動をスキップします");
      return;
    }

    await initializeDetailPage();
    console.log("ResearchDeck: Content Script 処理が完了しました");
  } catch (err) {
    console.error("ResearchDeck: 予期しないエラーが発生しました -", err);
  }
})();
