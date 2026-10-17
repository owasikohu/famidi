# famidi MIDI Console

MIDIキーボード → browser（Web MIDI）→ famidi → ファミコン実機。
[本人専用のWebアプリ](https://famidi-midi-console.rockygnome512.chatgpt.site) またはlocalhostから使う。
MIDIデータ・機器名はサーバーへ送らず、ブラウザで直接処理する。外部CDN・ビルド・実行時依存なし。
ファーム単体でもDAW等から演奏でき、Webアプリは必須ではない。

## 最初に使う

1. 新しい `build-midi/famidi.uf2` をPico 2へ書く（NES OFF、既存配線のまま）。
2. famidiとMIDIキーボードをPCのUSBへ接続し、Pico起動後にNESをONにする。
3. Chrome / Edgeでアプリを開き、「MIDIに接続」でアクセスを許可する。
4. MIDI入力に `Oxygen 25` 等、出力に **`famidi Pulse 1`** を選ぶ。4音源版でもUSB名は従来どおり。
5. 初期モードはMono / Pulse 1。「3-voice Poly」にすると和音を3音源に割り当てる。
6. Oxygenを使う場合はプリセットを選んで「適用」。ノブを回し、MIDI monitorのIN CC番号で割当を確認する。

先行のch1専用ファームでもMono/Pulse 1は利用できるが、ch2–4・Duty・Expression・Sweepには新ファームが必要。
PCのUSB MIDIポート同士を橋渡しする構成で、Picoに鍵盤を直接挿すUSB hostではない。
Web MIDIは [HTTPS/localhostと明示的なアクセス許可](https://www.w3.org/TR/webmidi/) が必要。
埋め込みプレビューで許可されない場合は通常のChrome / Edgeタブで開く。

## 演奏モード

| モード | Noteのルーティング | 離鍵・声不足時 |
|---|---|---|
| Original互換 | 入力ch1=Pulse 1、2=Pulse 2、3=Triangle、4=Noise。その他は無視 | 各ch最後のNoteを優先。前の保持音には戻らない |
| Mono | 選択した音源へ集約。入力chフィルタも設定可能 | 最後のNoteを優先し、離鍵で前の保持音へ復帰 |
| 3-voice Poly | 空いているPulse 1→Pulse 2→Triangleの順 | 満杯なら割当済みの最も古い声を使用。保持した被奪取音は同じ声の離鍵時に復帰 |

Polyでは音域に合う声だけ使う。21–32はTriangleのみ、97–108はPulseのみ。
Noteを奪われた後の古いNote Offは新しい音を消さない。
Original/Monoの画面・PC鍵盤は音源選択に従い、「全音源」のとき鍵盤はPulse 1、コントロールは全音源へ送る。
Polyの画面コントロールは3つの音程音源にまとめて送る。Duty/SweepはPulseのみ。
特定音源だけの操作はCC割当行で固定の送信先を指定できる。

Pad割当は全モードで優先し、入力ch/Noteが一致するとch4 Noiseへ送る。移調は適用しない。
初期値はch10のNote36→Noise4、38→10、42→0、46→2。
Padのch/Note/Noise NoteはGUIで変更・追加・削除できる。空にすると通常の鍵盤として扱う。
入力chフィルタはPadにも適用するので、鍵盤ch1とPad ch10を両方使う場合は「すべて」にする。

## CC割当と飛び対策

各行で入力（CC番号またはPitch wheel）、操作、送信先（モードに従う/全音源/固定音源）を選ぶ。
複数行への同時割当も可能。特定メーカー専用の処理は持たない。
CCをPitch Bendへ、Pitch wheelをDuty等へ割り当てることもできる。

汎用プリセットはCC7 Volume、CC11 Expression、CC70 Duty、CC13–16 Sweepと14bit Bend。
Oxygen 25開始用プリセットはCC1→Duty、CC74→Sweep時間、CC71→Sweep量、
CC91→Sweep ON、CC93→Sweep方向へ変更し、Volume/Expression/Bendは維持する。
**Oxygenの世代や保存済みの本体設定は自動判別しない。工場設定の一致を保証するプリセットではない。**
monitorで実際のCCを見て行を編集する。Oxygen以外でも同じGUIで設定できる。

連続CCは音源・入力機器・入力ch・割当行ごとに独立したフィルタを持つ。

1. 外れ値：前回の確定値との差が閾値超なら保留。120ms以内に差12以内の2サンプルが来れば実移動と認める。
2. 平滑化：時定数msの指数平滑化。ノブが停止しても16msごとのtickで確定値へ近づく。
3. ヒステリシス：境界付近の小変化を保持し、往復するCC送信を抑える。
4. 段階化：Pulse Volume/ExpressionとNoiseは16段階、Dutyは4段階、Sweep時間/量は8段階。Triangle音量は0/非0を維持する。

初期値は差48、35ms、ヒステリシス2。各0で無効化できる。
単発の大きな正規ジャンプも除去対象になるので、機器の値が段階的に一度だけ変わる場合は外れ値を0にする。
最初の値は即時採用。Pitch wheel→Bendは14bitのまま直接転送し、Note On/Offも遅延させない。
二値のSweep ON/方向もボタンの一度の操作を反映するため、フィルタを通さず閾値64で送る。
画面のPulse Volumeは16段階（MIDI値0,8,…120）。ファームがVelocity×Volume×Expressionを0–15へ変換する。

## 状態と保存

MIDI monitorは入力IN/実際の送信OUT、ch、CC/Note/Bend、値、hexを直近80件表示する。
音源表示は送信したNoteから計算し、NESの状態を読み返すものではない。
設定はlocalStorageに保存する（ポートは `famidi-ports`、演奏・割当・フィルタ・音量・画面鍵盤は `famidi-settings-v2`）。
壊れた設定や保存不可は演奏を妨げない。再読込でポートは自動で開かず、発音中NoteやBend偏位は保存しない。

入力/出力やモード・移調・割当を変更すると発音中の音とフィルタの残りを消す。
Esc/停止ボタンで全音源へCC120、ch1には旧PoC用の全音域Note Offも送る。
接続・再開時もまず消音してから保存したコントロールを送る。
入力を抜いた場合は残っている出力へ消音し、再接続後に「転送を開始」で再開する。

画面鍵盤はクリック・タッチ、PC鍵盤は `A W S E D F T G Y H U J K` に対応。
フォーカス移動は画面/PCの押下だけ解除し、物理鍵盤の転送は続ける。
ページ終了・freezeは全音停止する。OSやブラウザが強制終了した場合は、再接続またはDAWからCC120で停止する。
「A4を試す」は650ms。画面のVelocityはPC/画面/試聴用で、物理鍵盤のVelocityは受信値を使う。

## 開発・検証

```sh
make web          # http://localhost:8080（または web-midi/ で npm run dev）
make web-test     # Node標準ランナーの48テスト
make check-midi   # C/6502の26テスト、3版のバス応答、リンク後のコア・MSP・GPIO・ASM検証
```

`dist/midi.js` がルーティング/声の割当、`control.js` がCCフィルタ、
`controls-ui.js` が割当GUI、`settings.js` が設定保存、`app.js` がWeb MIDI接続・鍵盤・monitor。
Nodeテストは奪取/復帰/重複音/音域/2,000ランダムイベント、CC変換・外れ値・平滑化・ヒステリシス、
設定復元、旧PoC停止、出力切替・送信失敗を検証する。

`tests/browser.mjs` はPlaywrightによるポート模擬UIテスト。
入力/出力選択、PC/画面鍵盤、Original/Poly4音源、Pad、Oxygen適用・CC行編集、
monitor、再読込後の保存復元、抜き差し、権限拒否、390px画面の横幅を確認する。
`build-web-tools` にPlaywrightを用意し、`dist/` をlocalhost:8765で配信して
`node web-midi/tests/browser.mjs` を実行する。`QA_URL` / `QA_OUTPUT` / `BROWSER_EXECUTABLE` で変更可能。
このテストは実機へ送信しない。先行ch1版は実機成功済み、今回の4音源は実機確認が残る。

静的ファイルは `dist/`、Sites識別子は `.openai/hosting.json`。
Sites公開には既存プロジェクトと `build-web-site/` の独立Gitチェックアウトを使い、ファームの履歴を含めない。
ファームの対応範囲と実機チェック列は [USB MIDI仕様](../docs/usb-midi.md) を参照。
