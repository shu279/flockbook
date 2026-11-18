# Antigravity Chat Status Bar

Herdr内で動くFlockbookのChat入力欄の下に、Model／In／Out／API換算（円）／Turnを常時表示します。
独立したSwift版Flockbook Mac Appの変更ではありません。既存のMarkdown描画、入力・承認操作、Agent管理を維持します。

入力欄の上には「送信しています…」「応答を待っています…」「処理しています…」を表示します。Herdrが現在の作業内容を報告する場合はその文言を使い、完了時は消えます。承認待ち・接続待ちは回転表示を止めます。表示はTerminal・会話・PIDごとに分離し、送信が確認できない場合も30秒後に未確認の表示へ切り替えます。アニメーションはHerdrネイティブ機能を使用し、追加の通信やポーリングは行いません。

Antigravityの実際の待機メッセージも、入力欄の上に「キュー待ち」として表示します。CLIが取り込む前の本文は会話ログに記録されないため、Herdrの既存`hc read <machine/terminal> --json`で現在のCLI画面を読み取ります。作業中は約2秒ごと、Chatから送信した直後にも更新します。CLI画面の完全な読取・現在のAgent・Terminal・PID・会話を照合し、別タブの古い応答は破棄します。CLIに取り込まれた項目は一覧から消え、読取失敗・接続断・承認待ちでは前回の一覧に「更新待ち」を付けます。本文は表示だけに使用し、自動再送・取消・割込は行いません。

キュー一覧は高さを制限したスクロール領域です。長文や画面外の項目がCLIで省略されている場合は「一部省略（CLIの表示）」を示し、件数は取得できたプレビューの数を「表示N件」として示します。省略された全文や全件数を推測しません。Mac側Modの変更だけで動作し、GCEの設定・実行ファイル・認証情報は変更しません。

回答の行高計算では、Markdownリンクの非表示URLを除外し、先頭・連続する見出しの折り返しと行間を実測に合わせます。長いリンク先を本文として数え、見出しも大きく見積もっていたために末尾へ大きな空白を確保する問題を修正しています。Markdownの描画処理・文字サイズ・仮想スクロールは変更しません。

## データと計測

- GCE側の`statusline.sh`が[公式Status Line API](https://antigravity.google/docs/cli/statusline/)のJSONを受け取ります。元スクリプトのANSI色、桁区切り、モデル・Effort、subagent cost表示、画面幅に応じた折り返しを再利用しています。
- モデル・Effort・Agent状態はAPIから取得します。公式`cost.total_usd`は現在の環境では未報告です。Terminalの既存Est表示はこの値を使用し、未報告時は`N/A`を維持します。Chatの「API換算」は下記の公開単価による独立した参考額です。
- CLI 1.5.10の実機では`context_window.total_input_tokens`が現在のコンテキスト量と一致し、累計ではありませんでした。そのためIn／Outは対応する`transcript_full.jsonl`の使用量を累計します。Inは[公式headless usageの定義](https://antigravity.google/docs/cli/headless/)と同じ`input_tokens`累計で、別項目の`cache_read_tokens`は加算しません。Outは`output_tokens`累計です。使用量が記録された時点で増えます。
- Turnは`working`／`tool_use`の区間だけをGCEの単調増加時計で積算します。Idle、承認待ち、reviewing、認証中は加算しません。次の作業開始でリセットします。Session Wall Timeは表示しません。
- 導入時点で既に作業中だったターンは開始境界を観測できないため`N/A`です。Idleから次の作業開始を観測すれば計測が始まります。ログの`created_at`は処理終了時刻ではないため、代わりには使いません。
- MacはHerdrの既存`exec(..., {on: machine})`を通して、GCEの`statusline_bridge.py --read`を実行します。作業中は約1秒、Idle時は約2秒間隔。長いツール実行中やタブ切替後も、GCE側で現在の経過時間を計算するためMacとGCEの時計差に依存しません。
- Machine＋Terminal＋Conversation＋実行中PIDを照合します。キャッシュは`<transcript_full.jsonl>.flockbook-status.<terminal-id>.json`。最新ファイルの推測や全Agent共通のファイルは使用しません。
- 接続断や読取失敗は前回値を保持して`更新待ち`を表示し、画面上の時計を止めます。再接続時はリモート側の実測値に戻ります。

追加のSSH接続、認証情報、外部HTTP APIは使用しません。JSONキャッシュは0600、内部状態用ディレクトリは0700です。会話本文、メールアドレス、認証情報はキャッシュへ保存しません。

## 円での使用量管理

Chatの「API換算」は、**この会話と明示的に起動した子Agentの、割引前の公開API単価相当額**です。金額をクリックすると、モデル別の入力／キャッシュ読込／出力、USD相当額、未計上の件数、集計範囲、為替レートを表示します。In／Outは従来どおり親会話の累計です。

- 使用量を各リクエストに記録されたモデル別に集計します。途中でCarbonからArgonへ変更しても、過去の使用量を現在のモデルで再計算しません。推論トークンは出力に含まれるため重複加算しません。
- 子Agentは、親ログの`invoke_subagent`応答にある作成結果を照合して追跡します。同じbrainディレクトリの会話ID・ログURIを検証し、入れ子を再帰集計します。重複・循環には一度だけ計上し、無関係なAgentや最新ログを検索して混ぜません。読取不能・探索制限・不完全な使用量は未計上扱いです。
- モデル不明のCHECKPOINTなどは近隣のモデルから推測しません。既知分だけを`約¥…＋（一部未計上）`と表示し、詳細に未計上を示します。計算できる記録がなければ`N/A`です。古いBridgeの親会話のみのデータには`（親のみ）`を表示します。
- [Googleの公開料金](https://cloud.google.com/model-garden/pricing)を2026-11-18に確認し、Gemini 4 Carbon／ArgonのGlobal Standardを基準にしています。100万トークン当たり入力$4、キャッシュ読込$0.20、出力$20です。11月の50%クレジット還元は適用しません。High等はReasoning Effortで、Priorityサービス料金とは区別します。未知のモデルに別モデルの単価を流用しません。
- 実際の課金経路・リージョンはログから確定できないため、Global Standardは明示した計算基準です。請求額、サブスクリプション枠、クレジット、契約割引、ツール料金、税金は含みません。
- 初期為替は[日銀2026-11-17の17時USD/JPY](https://www.boj.or.jp/statistics/market/forex/fxdaily/fxlist/fx261117.pdf)159.33–35の中値、**1 USD = 159.34円**。自動更新せず、詳細パネルの入力欄から変更できます。請求に使われる[Cloudの月次換算](https://docs.cloud.google.com/billing/docs/resources/currency)とは異なります。

為替を保存すると既存のFlockbook設定に`cost_reference`だけを追加・更新します。他の設定は維持します。必要なら同項目の`region`を`"non-global"`に指定でき、その場合の単価は入力$4.40／キャッシュ$0.22／出力$22です。単価と初期為替はバージョンに固定されているため、公開価格改定時には更新が必要です。

## 導入

必要なものは、導入済みのFlockbook Herdr Mod、接続済みHerdr machine、GCEのPython 3／jq／Bashです。元ModはこのForkの基点`49466a1`と同じ`chat.js`・`composer.js`・`estimate.js`・`config.js`を対象にしています。変更済みの対象ファイルや既存の導入先には上書きせず停止します。

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

今回の円換算対応は、既存のカスタム`flockbook-status`をバックアップしてから、`config.js`・`chatstatus.js`・`cost.js`・`costview.js`だけを更新しました。GCEは上記デプロイ手順でPython helperを更新しています。元の`flockbook`には変更を加えていません。別環境へ導入する場合は新規インストール手順を使い、既存カスタムModがある場合は変更を比較してからマージしてください。

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

円換算対応だけを戻す場合は、Macの`~/.config/herdr-app/flockbook-status-backups/yen-20261118T033252.863837Z/flockbook-status`にある更新前のModと比較し、今回変更したファイルだけを復元できます。GCE側も対応する導入前バックアップのPython helperを復元できます。`settings.json`の復元は不要です。

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
| Mod全体の自動テスト | 390件中385成功、5件は既存の環境依存スキップ、失敗0 |
| Python Bridge／トークン集計／Terminal表示 | 51件成功（上記Modテストからも実行） |
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
| 円換算 | 実APIの`cost`欠落を確認。Chatではログのモデル別使用量を公開単価で円換算。Terminalの公式Estは`N/A`を維持 |
| 子Agent合算 | 親ログに明示された子ログだけを追跡し、親In／Outを維持。実ログの読取約73ms、Herdr経由の読取約247ms |
| 料金内訳 | 実画面で円・USD・未計上件数・子Agent範囲・モデル別単価・為替を確認。開閉と詳細内スクロール成功。為替保存の設定保全は自動テストで検証 |
| 設定保全 | GCEの`settings.json`はバックアップと完全一致。元Mod／既存キー設定も維持 |

実機の接続を意図的に切る試験はしていません。切断時の停止・再接続、非同期応答の逆転、同一会話の別端末、プロセス再起動、承認待ちの時間除外は合成データのテストで確認しています。課金額の取得や実際の承認送信は検証対象外です。

## 制約

- 円換算は会話単位の公開単価相当額です。別の独立した会話をまたぐ日次・月次合算、予算上限通知、実請求額の照合は行いません。モデル不明・単価未登録・未読取の使用分は未計上です。
- ログに未記録のストリーミング途中のトークン数は取得できません。モデル応答などの使用量確定時に更新します。
- 状態遷移の分解能はCLIのStatus Line呼び出しに依存します（公式仕様では最大300ms間隔）。CLIが状態通知せず強制終了した区間は正確な終了時刻を復元できず、読取失敗／更新待ちとして扱います。
- 接続を切った実機試験は既存の作業へ影響するため行わず、切断・エラー・再接続は自動テストで検証します。
- 他のCLIの値はこの拡張の対象外で、Status Barは未取得値を表示します。
- 行高は描画前の見積もりです。複雑なMarkdownで本文が切れないよう少量の余裕を残します。現在の実機では修正対象の長い回答で約52px残ります。
- CLIがHerdrへ具体的な作業名を渡さない場合、活動表示は「処理しています…」になります。作業内容を推測した文言は表示しません。
- キュー本文はAntigravity CLI 1.5.10の画面形式を対象にしています。CLIが省略した本文は復元できません。画面形式を判別できない場合は前回の取得値に「更新待ち」を付け、取得済みの一覧がなければ表示しません。
