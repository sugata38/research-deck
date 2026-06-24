// ============================================================
// ResearchDeck - Options Page ロジック
// SP-API認証情報の保存・読み込み・接続テスト
// ============================================================

// --- DOM要素の参照 ---
const form = document.getElementById("rd-settings-form");
const clientIdInput = document.getElementById("rd-client-id");
const clientSecretInput = document.getElementById("rd-client-secret");
const refreshTokenInput = document.getElementById("rd-refresh-token");
const sellerIdInput = document.getElementById("rd-seller-id");
const saveBtn = document.getElementById("rd-save-btn");
const testBtn = document.getElementById("rd-test-btn");
const statusDiv = document.getElementById("rd-status");

// ============================================================
// ページ読み込み時に保存済みの設定を復元
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const data = await chrome.storage.local.get([
      "sp_client_id",
      "sp_client_secret",
      "sp_refresh_token",
      "sp_seller_id",
    ]);

    // 保存済みの値をフォームに反映
    if (data.sp_client_id) clientIdInput.value = data.sp_client_id;
    if (data.sp_client_secret) clientSecretInput.value = data.sp_client_secret;
    if (data.sp_refresh_token) refreshTokenInput.value = data.sp_refresh_token;
    if (data.sp_seller_id) sellerIdInput.value = data.sp_seller_id;
  } catch (err) {
    console.error("ResearchDeck: 設定の読み込みに失敗しました -", err);
  }
});

// ============================================================
// 保存処理
// ============================================================

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  // 入力値を取得（前後の空白を除去）
  const clientId = clientIdInput.value.trim();
  const clientSecret = clientSecretInput.value.trim();
  const refreshToken = refreshTokenInput.value.trim();
  const sellerId = sellerIdInput.value.trim();

  // --- バリデーション（入力チェック） ---
  if (!clientId || !clientSecret || !refreshToken || !sellerId) {
    showStatus("すべてのフィールドを入力してください。", "error");
    return;
  }

  // 保存ボタンを無効化（二重送信防止）
  saveBtn.disabled = true;
  saveBtn.textContent = "保存中...";

  try {
    // chrome.storage.local に保存
    await chrome.storage.local.set({
      sp_client_id: clientId,
      sp_client_secret: clientSecret,
      sp_refresh_token: refreshToken,
      sp_seller_id: sellerId,
    });

    // 古いキャッシュトークンをクリア（新しい認証情報で再取得するため）
    await chrome.storage.local.remove(["sp_access_token", "sp_token_expires_at"]);

    showStatus("✅ 設定を保存しました。楽天の商品ページを再読み込みすると反映されます。", "success");
  } catch (err) {
    showStatus(`❌ 保存に失敗しました: ${err.message}`, "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "保存する";
  }
});

// ============================================================
// 接続テスト
// ============================================================

testBtn.addEventListener("click", async () => {
  // 未保存の入力値がある場合は先に保存を促す
  const clientId = clientIdInput.value.trim();
  const clientSecret = clientSecretInput.value.trim();
  const refreshToken = refreshTokenInput.value.trim();
  const sellerId = sellerIdInput.value.trim();

  if (!clientId || !clientSecret || !refreshToken || !sellerId) {
    showStatus("接続テストの前に、すべてのフィールドを入力して保存してください。", "error");
    return;
  }

  // テストボタンを無効化
  testBtn.disabled = true;
  testBtn.textContent = "テスト中...";
  showStatus("🔄 SP-APIへの接続をテストしています...", "info");

  try {
    // まず現在の入力値を保存
    await chrome.storage.local.set({
      sp_client_id: clientId,
      sp_client_secret: clientSecret,
      sp_refresh_token: refreshToken,
      sp_seller_id: sellerId,
    });
    // 古いトークンキャッシュをクリア
    await chrome.storage.local.remove(["sp_access_token", "sp_token_expires_at"]);

    // Service Workerに接続テストをリクエスト
    const result = await chrome.runtime.sendMessage({ type: "TEST_SP_API_CONNECTION" });

    if (result && result.success) {
      showStatus(`✅ ${result.message}`, "success");
    } else {
      showStatus(`❌ ${result.error || "接続に失敗しました"}`, "error");
    }
  } catch (err) {
    showStatus(`❌ テスト中にエラーが発生しました: ${err.message}`, "error");
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = "接続テスト";
  }
});

// ============================================================
// ステータスメッセージ表示
// ============================================================

/**
 * ステータスメッセージを表示する
 *
 * @param {string} message - 表示するメッセージ
 * @param {string} type - メッセージの種類（"success" | "error" | "info"）
 */
function showStatus(message, type) {
  statusDiv.textContent = message;
  statusDiv.hidden = false;

  // タイプに応じてスタイルを切り替え
  statusDiv.className = `rd-status rd-status-${type}`;

  // 成功メッセージは5秒後に自動で消す
  if (type === "success") {
    setTimeout(() => {
      statusDiv.hidden = true;
    }, 5000);
  }
}
