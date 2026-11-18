# Antigravity Chat Status Bar

Herdr内で動くFlockbookのChat入力欄の下に、Model／In／Out／Est／Turnを常時表示します。
独立したSwift版Flockbook Mac Appの変更ではありません。既存のMarkdown描画、入力・承認操作、Agent管理を維持します。

入力欄の上には「送信しています…」「応答を待っています…」「処理しています…」を表示します。Herdrが現在の作業内容を報告する場合はその文言を使い、完了時は消えます。承認待ち・接続待ちは回転表示を止めます。表示はTerminal・会話・PIDごとに分離し、送信が確認できない場合も30秒後に未確認の表示へ切り替えます。アニメーションはHerdrネイティブ機能を使用し、追加の通信やポーリングは行いません。

Antigravityの実際の待機メッセージも、入力欄の上に「キュー待ち」として表示します。CLIが取り込む前の本文は会話ログに記録されないため、Herdrの既存`hc read <machine/terminal> --json`で現在のCLI画面を読み取ります。作業中は約2秒ごと、Chatから送信した直後にも更新します。CLI画面の完全な読取・現在のAgent・Terminal・PID・会話を照合し、別タブの古い応答は破棄します。CLIに取り込まれた項目は一覧から消え、読取失敗・接続断・承認待ちでは前回の一覧に「更新待ち」を付けます。本文は表示だけに使用し、自動再送・取消・割込は行いません。

キュー一覧は高さを制限したスクロール領域です。長文や画面外の項目がCLIで省略されている場合は「一部省略（CLIの表示）」を示し、件数は取得できたプレビューの数を「表示N件」として示します。省略された全文や全件数を推測しません。Mac側Modの変更だけで動作し、GCEの設定・実行ファイル・認証情報は変更しません。

回答の行高計算では、Markdownリンクの非表示URLを除外し、先頭・連続する見出しの折り返しと行間を実測に合わせます。長いリンク先を本文として数え、見出しも大きく見積もっていたために末尾へ大きな空白を確保する問題を修正しています。Markdownの描画処理・文字サイズ・仮想スクロールは変更しません。

## データと計測

- GCE側の`statusline.sh`が[公式Status Line API](https://antigravity.google/docs/cli/statusline/)のJSONを受け取ります。元スクリプトのANSI色、桁区切り、モデル・Effort、subagent cost表示、画面幅に応じた折り返しを再利用しています。
- モデル・Effort・コスト・Agent状態はAPIから取得します。`cost`未報告時は`N/A`。公開価格や課金額を推測してゼロにしません。明示的に報告されたゼロだけをゼロとして表示します。
- CLI 1.5.10の実機では`context_window.total_input_tokens`が現在のコンテキスト量と一致し、累計ではありませんでした。そのためIn／Outは対応する`transcript_full.jsonl`の使用量を累計します。Inは[公式headless usageの定義](https://antigravity.google/docs/cli/headless/)と同じ`input_tokens`累計で、別項目の`cache_read_tokens`は加算しません。Outは`output_tokens`累計です。使用量が記録された時点で増えます。
- Turnは`working`／`tool_use`の区間だけをGCEの単調増加時計で積算します。Idle、承認待ち、reviewing、認証中は加算しません。次の作業開始でリセットします。Session Wall Timeは表示しません。
- 導入時点で既に作業中だったターンは開始境界を観測できないため`N/A`です。Idleから次の作業開始を観測すれば計測が始まります。ログの`created_at`は処理終了時刻ではないため、代わりには使いません。
- MacはHerdrの既存`exec(..., {on: machine})`を通して、GCEの`statusline_bridge.py --read`を実行します。作業中は約1秒、Idle時は約2秒間隔。長いツール実行中やタブ切替後も、GCE側で現在の経過時間を計算するためMacとGCEの時計差に依存しません。
- Machine＋Terminal＋Conversation＋実行中PIDを照合します。キャッシュは`<transcript_full.jsonl>.flockbook-status.<terminal-id>.json`。最新ファイルの推測や全Agent共通のファイルは使用しません。
- 接続断や読取失敗は前回値を保持して`更新待ち`を表示し、画面上の時計を止めます。再接続時はリモート側の実測値に戻ります。

追加のSSH接続、認証情報、外部HTTP APIは使用しません。JSONキャッシュは0600、内部状態用ディレクトリは0700です。会話本文、メールアドレス、認証情報はキャッシュへ保存しません。

## 導入

必要なものは、導入済みのFlockbook Herdr Mod、接続済みHerdr machine、GCEのPython 3／jq／Bashです。元ModはこのForkの基点`49466a1`と同じ`chat.js`・`composer.js`・`estimate.js`を対象にしています。変更済みの対象ファイルや既存の導入先には上書きせず停止します。

リポジトリルートでMac側を導入します。

```sh
python3 -B herdr-app/install-status-mod.py --activate
```

別名の`flockbook-status` Mod／Layoutを作り、元の`flockbook`を残します。既存のFlockbook helperと設定はそのまま利用します。新Layout専用のキー設定を追加し、元のキー設定は保存します。

GCEの現行スクリプトと添付修正版を比較し、確認したSHA256を指定して導入します。`MACHINE`は`hc machine ls`に出る既存の名前です。

```sh
hc exec --on MACHINE sh -c 'sha256sum "$HOME/.gemini/antigravity-cli/statusline.sh"'
python3 -B herdr-app/antigravity/deploy.py --machine MACHINE --expected-sha256 REVIEWED_SHA256
```

導入は既存`statusLine.command`が`~/.gemini/antigravity-cli/statusline.sh`であることを確認します。スクリプトが比較後に変わっていたら停止します。元スクリプトと設定をタイムスタンプ付きバックアップに保存し、helperを先に配置してからスクリプトを原子的に置換します。`settings.json`は書き換えません。

稼働中のCLIは次のStatus Line呼び出しから変更を読み込みます。Idle中に呼び出されなければ次の通常操作で反映します。既存の会話へ検証用メッセージを送る必要はありません。

## 元に戻す

Macは元Layoutへ切り替えるだけです。

```sh
herdr-app do layout.switch '{"name":"flockbook"}'
```

GCEは導入時に表示されたバックアップの`statusline.sh`を元の場所へ戻します。設定は変更していないため復元不要です。追加したPythonファイルとキャッシュは残っていても、元スクリプトから呼び出されません。

```sh
hc exec --on MACHINE sh -c 'cp "$HOME/.gemini/antigravity-cli/flockbook-status-backups/BACKUP_ID/statusline.sh" "$HOME/.gemini/antigravity-cli/statusline.sh"'
```

元Layout／Mod／設定をバックアップ一式で無条件に上書きしないでください。導入後のユーザー変更を失わないためです。

## 検証

```sh
(cd herdr-app && npm test)
python3 -B -m unittest discover -s herdr-app/antigravity -p 'test_*.py' -v
bash -n herdr-app/antigravity/statusline.sh
herdr-app check herdr-app/mods/flockbook
git diff --check
```

JavaScript ModはHerdrが直接ロード・コンパイルします。Swift AppやRust helperは変更しておらず、それらの再ビルド／置換は不要です。`herdr-app check`に加えて実際のHerdr画面で描画を確認してください。

実セッションの確認には専用の空ディレクトリと専用Terminalを使い、`agy --settings`のセッション限定設定を利用します。既存の作業中Agentに入力や承認を送らないでください。

### 2026-11-18の実機確認

macOS上のHerdr App 0.1.16／GCE Linux上のAntigravity CLI 1.5.10で検証しました。

| 検証 | 結果 |
|---|---|
| Mod全体の自動テスト | 363件中358成功、5件は既存の環境依存スキップ、失敗0 |
| Python Bridge／トークン集計／Terminal表示 | 27件成功（上記Modテストからも実行） |
| Herdr Modのネイティブロード・コンパイル | ソース／導入先とも`check passed`、実行時エラーなし |
| Chat入力 | 実際の入力欄から検証用Agentへ送信成功 |
| 処理中表示 | 専用の実CLIで、送信直後→処理中→完了時に非表示を確認。普段の作業中Agentでも表示 |
| キュー表示 | 専用の実CLIで、Chatから送った日本語を含む2件の表示と、CLI取込後に消えることを確認 |
| Markdown | 見出し・太字・Pythonコードブロック・表が表示された |
| 長い回答後の空白 | 同じ回答・760px幅で確保高さ3777→3211px。実寸3159pxに対する余剰618→52px。末尾の表・文章・フッターに欠けがないことを実機確認 |
| 実行中更新 | Turnが2秒から16秒へ進行し、完了後21秒で停止 |
| Idle除外 | 25.071秒間隔の読取で21,765.210msのまま一致 |
| 2 Agentの切替 | High: In17,168／Out475／21秒、Low: In8,801／Out8／5秒。切替後も混在なし |
| 元Terminal表示 | 両AgentでANSI Status Lineを継続表示 |
| 未取得コスト | 実APIの`cost`欠落を確認し、Chat／Terminalとも`N/A` |
| 設定保全 | GCEの`settings.json`はバックアップと完全一致。元Mod／既存キー設定も維持 |

実機の接続を意図的に切る試験はしていません。切断時の停止・再接続、非同期応答の逆転、同一会話の別端末、プロセス再起動、承認待ちの時間除外は合成データのテストで確認しています。課金額の取得や実際の承認送信は検証対象外です。

## 制約

- コストはCLIが報告するAPI相当の推定値です。現在のGCE環境では未報告なので`N/A`になります。サブスクリプション料金やGCP請求額の計算には使いません。
- ログに未記録のストリーミング途中のトークン数は取得できません。モデル応答などの使用量確定時に更新します。
- 状態遷移の分解能はCLIのStatus Line呼び出しに依存します（公式仕様では最大300ms間隔）。CLIが状態通知せず強制終了した区間は正確な終了時刻を復元できず、読取失敗／更新待ちとして扱います。
- 接続を切った実機試験は既存の作業へ影響するため行わず、切断・エラー・再接続は自動テストで検証します。
- 他のCLIの値はこの拡張の対象外で、Status Barは未取得値を表示します。
- 行高は描画前の見積もりです。複雑なMarkdownで本文が切れないよう少量の余裕を残します。現在の実機では修正対象の長い回答で約52px残ります。
- CLIがHerdrへ具体的な作業名を渡さない場合、活動表示は「処理しています…」になります。作業内容を推測した文言は表示しません。
- キュー本文はAntigravity CLI 1.5.10の画面形式を対象にしています。CLIが省略した本文は復元できません。画面形式を判別できない場合は前回の取得値に「更新待ち」を付け、取得済みの一覧がなければ表示しません。
