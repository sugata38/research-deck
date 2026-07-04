# Chrome Web Store Listing — ResearchDeck

> Last Updated: 2026-07-05

## Store Listing

**Extension Name**  
ResearchDeck

**Short Description**  
楽天市場・楽天ビック・ヤフショの商品ページから実質仕入れ値を自動計算し、Amazonの利益や出品可否を分析するリサーチツール。

**Detailed Description**  
楽天市場やヤフーショッピングなどの商品詳細ページにおいて、自動的にResearchDeckダッシュボードを起動し、JANコード・価格・ポイント・クーポンを自動抽出します。
また、Amazon SP-API経由で該当商品のASIN、販売価格、各種FBA手数料、出品可否ステータス、月間推定販売数などを一元取得し、その場で実質仕入れ値と粗利益を即座にシミュレーションします。

■ 主な機能
- 楽天市場、楽天ビック、Yahoo!ショッピング、LOHACOの商品ページに自動対応
- JANコードの高速自動検出、および各種識別子（ASIN/JAN）のワンクリックコピー
- SPUなどの追加ポイント倍率やクーポン割引額の手動調整・リアルタイム再計算
- Amazon出品制限（要申請ステータス）のバッジ表示および申請用直結リンク
- FBA月間保管手数料の体積ベースの正確な計算と計算式ツールチップ表示
- 推定月間販売数の表示（バリエーション合算値に対する警告バッジ機能付き）

■ 使い方
1. 本拡張機能を有効化した状態で、楽天市場やヤフーショッピングの各商品詳細ページを開きます。
2. 画面上に自動でResearchDeckのダッシュボードが表示され、自動計算が開始されます。
3. 必要に応じて追加ポイントやクーポン値引き額を微調整し、実質仕入れ値をシミュレートしてください。

**Category**  
Developer Tools

**Single Purpose**  
ECサイトの商品ページから実質仕入れ値とAmazon手数料を自動抽出し、利益を計算します。

**Primary Language**  
Japanese

---

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128×128 PNG | ✅ Ready | `research-deck/lib/icon128.png` |
| Screenshot 1 | 1280×800 or 640×400 | ✅ Ready | `screenshot/main_dashboard.png` |

---

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | ユーザーが入力した追加ポイント率やクーポン値引きなどの設定、およびダッシュボードの表示位置（ドラッグ位置）をローカルに永続化して次回表示時に復元するために使用します。 |
| `https://api.amazon.com/*` | host_permissions | AmazonのSP-API連携のために、OAuth 認証トークンやAPI認証情報をやり取りする通信に使用します。 |
| `https://sellingpartnerapi-fe.amazon.com/*` | host_permissions | Amazon Selling Partner API (SP-API) の極東 (FE) エンドポイントへアクセスし、商品の出品規制・価格情報・各種FBA手数料を取得するために使用します。 |
| `https://sellercentral.amazon.co.jp/*` | host_permissions | Amazonセラーセントラル上でFBA料金シミュレーターや出品申請ページに直結リンクする機能、およびセラーセントラル専用スクリプトの連携のために使用します。 |
| `https://store.shopping.yahoo.co.jp/*` | host_permissions | ヤフーショッピング上の商品詳細ページから価格・ポイント情報を読み取るコンテンツスクリプトを安全に適用するために使用します。 |

---

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

---

## Privacy Policy

**Privacy Policy URL**  
本拡張機能は、ユーザーのいかなる個人情報、行動履歴、ウェブ閲覧履歴も収集または外部サーバーへ転送しません。すべてのAPI通信および設定値の保存は、ユーザー自身の端末（ローカルストレージ）およびAmazonの公式APIとの安全な直接通信のみで完結します。

---

## Distribution

**Visibility**: Private (個人利用ツール)  
**Regions**: Japan  
**Pricing**: Free  

---

## Developer Info

**Publisher Name**  
Masaru

**Contact Email**  
(個人管理のためダッシュボードに記載)

---

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.2.3 | 2026-07-05 | 楽天ビック（biccamera.rakuten.co.jp）の商品詳細ページに自動対応。URLおよび隠しトラッキングinputからの高速JAN・価格抽出、および動的ポイント描画に対応。 | Draft |
| 1.2.2 | 2026-07-04 | ヤフーショッピングの「今すぐ利用」ポイントの内訳抽出の誤検知防止強化。 | Published |
| 1.2.1 | 2026-07-02 | 初期リリース。楽天市場およびヤフーショッピングの利益計算ダッシュボードの提供。 | Published |
