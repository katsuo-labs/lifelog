# ライフログ(筋トレ・脱毛・食事記録 PWA)

PC/スマホのブラウザで動く個人用ライフログアプリ。データは端末内(localStorage)にのみ保存されます。

## ファイル構成

```
lifelog/
├── index.html      # 画面(4タブ: 筋トレ/脱毛/食事/設定)
├── styles.css      # スタイル(ダークモード自動対応)
├── app.js          # ロジック(localStorage保存)
├── manifest.json   # PWAマニフェスト
├── sw.js           # Service Worker(オフラインキャッシュ)
└── icons/
    ├── icon.svg            # アイコン元データ
    ├── icon-192.png        # PWAアイコン
    ├── icon-512.png        # PWAアイコン
    └── apple-touch-icon.png # iOS用(180px)
```

## 公開URL

**https://katsuo-labs.github.io/lifelog/**

リポジトリ: https://github.com/katsuo-labs/lifelog(Pagesは`gh-pages`ブランチから配信)

## 更新のデプロイ手順

ファイルを変更したら、`sw.js` の `CACHE_NAME` を上げてから、mainと`gh-pages`の両ブランチにプッシュ:

```bash
cd "/Users/Takashi/claude code/lifelog"
git add .
git commit -m "変更内容"
git push origin main main:gh-pages
```

※ manifest・Service Workerはすべて相対パスで書いてあるため、サブパス(`/lifelog/`)公開でそのまま動きます。

## スマホのホーム画面に追加(PWA)

- **iPhone (Safari)**: 公開URLを開く → 共有ボタン → 「ホーム画面に追加」
- **Android (Chrome)**: 公開URLを開く → メニュー → 「ホーム画面に追加」(または「アプリをインストール」)

一度開けばオフラインでも起動できます。

## 更新時の注意

`sw.js` の `CACHE_NAME`(`lifelog-v1`)の数字を上げ忘れると古いキャッシュが配信され続けます(例: `lifelog-v2` に変更)。新バージョンは次回起動時(2回目の表示)に反映されます。

## データのバックアップ

設定タブ → 「エクスポート(JSON)」でバックアップファイルを保存できます。機種変更時は新端末で「インポート」してください。

## ローカルでの動作確認

```bash
cd "/Users/Takashi/claude code/lifelog"
python3 -m http.server 8765
# → http://localhost:8765 を開く
```
