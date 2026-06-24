// ============================================================
// ResearchDeck - Amazon FBA料金シミュレーター自動入力スクリプト
// 料金シミュレーターページでURLパラメータからASINを抽出し、
// 自動的に検索窓に入力して検索を実行します。
// ============================================================

(function() {
  console.log("ResearchDeck: Amazon FBA料金シミュレーター監視プロセスを開始しました。");

  let lastProcessedUrl = "";

  function checkAndExecute() {
    const currentUrl = window.location.href;
    
    // すでにこのURLで処理済みの場合は重複実行を防ぐためスキップ
    if (currentUrl === lastProcessedUrl) return;

    // シミュレーターのURLパターンであるか確認
    const isCalculatorPage = currentUrl.includes('/revcal') || currentUrl.includes('/profitabilitycalculator/index');
    if (!isCalculatorPage) return;

    const urlParams = new URLSearchParams(window.location.search);
    const asin = urlParams.get('asin') || urlParams.get('searchKey');

    if (!asin) return;

    // 処理中フラグをセット
    lastProcessedUrl = currentUrl;
    console.log("ResearchDeck: シミュレーターページとASINを検知しました。自動入力を実行します。ASIN:", asin);

    let attempts = 0;
    const maxAttempts = 40; // 最大40回（20秒間）試行する
    const interval = setInterval(() => {
      attempts++;
      
      // 全ての入力欄を取得
      const inputs = document.querySelectorAll('input');
      
      // ヘッダーやナビゲーション以外のコンテンツ領域にある、表示されているテキスト入力欄を絞り込む
      const contentInputs = Array.from(inputs).filter(input => {
        const type = input.getAttribute('type') || 'text';
        if (type !== 'text' && type !== 'search' && type !== '') return false;
        
        const isVisible = input.offsetWidth > 0 && input.offsetHeight > 0;
        if (!isVisible) return false;
        
        // 標準のheader/navタグ、およびセラーセントラル全体のヘッダーID/クラス（sc-headerなど）の中にあるものは除外
        // 部分一致の [class*="header"] を使うとコンテンツエリア内のヘッダー要素まで除外されるため、厳密に指定
        const isGlobalHeaderOrNav = input.closest('header, nav, #sc-header, #partner-header, .sc-header, .sc-navigation');
        if (isGlobalHeaderOrNav) return false;
        
        // プレースホルダーが単に「検索」または「search」のみのグローバル検索窓は除外
        const placeholder = (input.getAttribute('placeholder') || '').trim().toLowerCase();
        if (placeholder === '検索' || placeholder === 'search') return false;
        
        return true;
      });

      let targetInput = null;
      if (contentInputs.length > 0) {
        // プレースホルダーにASINや検索に関連するワードが入っているものを最優先
        targetInput = contentInputs.find(input => {
          const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
          return placeholder.includes('asin') || placeholder.includes('sku') || placeholder.includes('search') || placeholder.includes('検索');
        }) || contentInputs[0];
      }

      if (targetInput) {
        console.log("ResearchDeck: シミュレーターの検索窓を検出しました:", targetInput);
        clearInterval(interval); // 検索窓が見つかったのでループを停止

        // 値を入力
        targetInput.value = asin;
        
        // Reactなどのフレームワークに変更を確実に検知させる
        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        targetInput.dispatchEvent(new Event('change', { bubbles: true }));
        targetInput.dispatchEvent(new Event('blur', { bubbles: true }));
        
        // 少し待ってから検索を実行（JS側の状態更新を待つ）
        setTimeout(() => {
          // ボタンを探す（入力欄の親要素の中から探すことで、ヘッダーの検索ボタンを誤クリックするのを防ぐ）
          let searchButton = null;
          let parent = targetInput.parentElement;
          
          // 5階層上まで親をたどってその中からボタンを探す
          for (let i = 0; i < 5; i++) {
            if (!parent) break;
            const btns = parent.querySelectorAll('button, input[type="button"], input[type="submit"]');
            for (const btn of btns) {
              const text = (btn.textContent || btn.value || '').trim();
              if (text.includes('検索') || text.toLowerCase().includes('search')) {
                searchButton = btn;
                break;
              }
            }
            if (searchButton) break;
            parent = parent.parentElement;
          }

          // 親要素の中から見つからなかった場合のフォールバック（ヘッダー外のボタンを優先）
          if (!searchButton) {
            const buttons = document.querySelectorAll('button, input[type="button"], input[type="submit"]');
            const contentButtons = Array.from(buttons).filter(btn => {
              const isHeader = btn.closest('header, nav, #sc-header, #partner-header, .sc-header, .sc-navigation');
              return !isHeader && btn.offsetWidth > 0 && btn.offsetHeight > 0;
            });
            
            for (const btn of contentButtons) {
              const text = (btn.textContent || btn.value || '').trim();
              if (text.includes('検索') || text.toLowerCase().includes('search')) {
                searchButton = btn;
                break;
              }
            }
          }

          if (searchButton) {
            console.log("ResearchDeck: 検索ボタンをクリックします。");
            searchButton.click();
          } else {
            console.log("ResearchDeck: Enterキーで決定を実行します。");
            const enterEvent = new KeyboardEvent('keydown', {
              key: 'Enter',
              code: 'Enter',
              keyCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true
            });
            targetInput.dispatchEvent(enterEvent);
          }
        }, 150);
      }

      if (attempts >= maxAttempts) {
        console.log("ResearchDeck: タイムアウト。検索窓が見つかりませんでした。");
        clearInterval(interval);
      }
    }, 500);
  }

  // 1秒ごとにURL変更を定常監視（SPAのクライアントサイドルーティングによるURL書き換えに対応）
  setInterval(checkAndExecute, 1000);
  
  // 初回ロード時の実行
  checkAndExecute();
})();
