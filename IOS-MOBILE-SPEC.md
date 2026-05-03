# iOS / 携帯プレイ向けレイアウト仕様（148-depamigo）

対象: iPhone Safari を主とした縦持ちプレイ。デスクトップは従来の CRT 枠（4:3）を維持する。

## 1. ビューポート

- `viewport-fit=cover` でノッチ下まで描画し、`env(safe-area-inset-*)` で実表示域から UI を内側に寄せる。
- 高さは `100dvh` / `100svh` を併記し、アドレスバー伸縮の差を吸収する。

## 2. 画面領域（#crt）

| 条件 | 挙動 |
|------|------|
| 幅 > 896px かつ大きい表示 | 従来どおり `max(800px, 4:3)` の CRT 枠を中央配置。 |
| 幅 ≤ 896px かつ高さ ≤ 1400px | **全面表示**。`aspect-ratio`・`max-height` 制限を解除し、端末全体をゲーム面にする。 |

背景画像（`#bg.scene-photo`）は既存どおり `background-size: cover` でキャンバス全面を覆う。

## 3. 会話 UI（#dialog-dock）

- `#speaker` と `#textbox` を **縦 flex で下端に固定**。親指操作で本文が届く位置にそろえる。
- パディング下辺は `max(8px, env(safe-area-inset-bottom))` 以上とし、ホームインジケータと重ならない。

### テキスト (#textbox)

- **可変高**: `min-height` + `max-height: min(42dvh, 340px)`。長文でも下端に集約しつつ画面を占有しすぎない。
- **日本語**: `line-height: 1.88` 前後、`overflow-wrap: break-word`、`line-break: strict`。本文フォントは iOS では **システム UI 系**（`-apple-system`, ヒラギノ等）を優先し、ドットフォントはタイトル等に限定。
- **ガラス風**: `backdrop-filter: blur` + 半透明背景。`prefers-reduced-motion: reduce` では `backdrop-filter` を無効化。

### 話者名 (#speaker)

- テキストボックス直上。角丸・半透明＋ブラーでテキストエリアと視覚的に一体化。

## 4. タイトル画面（#title）

- `#title-frame` の `inset` と、エンディング数・PRESS・注釈・a11y・version の `top` / `bottom` / 横位置に `env(safe-area-inset-*)` を足し、ノッチ・ホームバーと重ならないようにする。
- ゲーム本編と同じ `@media (max-width: 896px) and (max-height: 1400px)` 内で上記を上書きする。

## 5. その他オーバーレイ

- **#choices**: 上端は `safe-area-inset-top` を考慮。選択肢が多いときは `max-height` + 縦スクロール（`-webkit-overflow-scrolling: touch`）。
- **#hud / #floor-telop / #stat-toast**: 上マージンに `safe-area-inset-top` を反映。
- **#portrait**: 縮小し、`bottom` をテキスト域の目安高さから算出して立ち絵と会話欄の干渉を減らす。

## 6. タッチ・スクロール

- グローバル: `touch-action: manipulation`、本文類は `user-select: none`。
- `touchmove` で `preventDefault`（`passive: false`）。**`#choices`・分岐マップ内は除外**し、選択肢やログの縦スクロールを許可する。`touchend` で短時間ダブルタップを抑止（プロジェクト標準）。

## 7. 実装ファイル

- マークアップ: `index.html` の `#dialog-dock`（話者＋本文のラッパー）
- スタイル: `style.css` の `@media (max-width: 896px) and (max-height: 1400px)` ブロック
- スクリプト: `script.js` 末尾のタッチハンドラ

仕様改版時は本書と CSS コメント（`IOS-MOBILE-SPEC.md` 参照）を同期すること。
