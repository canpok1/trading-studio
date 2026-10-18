// MCP で Claude に渡す、条件セット（戦略の params）の書き方。画面の項目と JSON の対応を伝える

import type { ConditionType, Judge } from "@trading-studio/core";
import {
	DEFAULT_FEE_RATES,
	JUDGMENT_VALUE_LABELS,
	JUDGMENT_VALUES,
	LIMITS,
	NO_JUDGMENT,
	strategyTemplate,
	TEMPLATE_IDS,
	TIMEFRAMES,
} from "@trading-studio/core";

// Record にしておき、条件の種類を足したら型エラーでここの書き足しに気づけるようにする
const CONDITIONS: Record<ConditionType, string> = {
	emaCross: `- \`{"type":"emaCross","timeframe":"1h","fast":12,"slow":48,"direction":"up"|"down"}\` 短期 EMA が長期 EMA を前の足から今の足の間に上抜け・下抜けた。本数 ${LIMITS.emaPeriod.min}〜${LIMITS.emaPeriod.max}、fast < slow`,
	breakout: `- \`{"type":"breakout","timeframe":"1h","lookback":20,"direction":"high"|"low"}\` 終値が今の足を除く直近 N 本の最高値を上回った・最安値を下回った。本数 ${LIMITS.lookback.min}〜${LIMITS.lookback.max}`,
	rsi: `- \`{"type":"rsi","timeframe":"1h","period":14,"threshold":30,"direction":"above"|"below"}\` RSI（Wilder 方式）が N 以上・以下。期間 ${LIMITS.rsiPeriod.min}〜${LIMITS.rsiPeriod.max}、しきい値 ${LIMITS.rsiThreshold.min}〜${LIMITS.rsiThreshold.max} の整数`,
	rsiCross: `- \`{"type":"rsiCross","timeframe":"1h","period":14,"threshold":30,"bars":1,"direction":"up"|"down"}\` RSI が直近 bars 本以内に threshold を上抜けた（前の足 < threshold ≦ その足）・下抜けた（前の足 > threshold ≧ その足）。bars 1 なら今の足だけ。期間 ${LIMITS.rsiPeriod.min}〜${LIMITS.rsiPeriod.max}、しきい値 ${LIMITS.rsiThreshold.min}〜${LIMITS.rsiThreshold.max}、bars ${LIMITS.rsiCrossBars.min}〜${LIMITS.rsiCrossBars.max} の整数`,
	emaPosition: `- \`{"type":"emaPosition","timeframe":"1h","period":200,"direction":"above"|"below"}\` 終値が EMA(N) より上・下（等しいときは成立しない）。本数 ${LIMITS.emaPeriod.min}〜${LIMITS.emaPeriod.max}`,
	emaSlope: `- \`{"type":"emaSlope","timeframe":"1h","period":50,"bars":5,"percent":0,"direction":"up"|"down"}\` EMA(N) が M 本前の EMA から percent% 以上上がっている・下がっている。percent 0 なら向きだけを見る（変化が 0 のときはどちらも成立しない）。本数 ${LIMITS.emaPeriod.min}〜${LIMITS.emaPeriod.max}、M ${LIMITS.emaSlopeBars.min}〜${LIMITS.emaSlopeBars.max}、percent ${LIMITS.emaSlopePercent.min}〜${LIMITS.emaSlopePercent.max}（0.01 刻み）`,
	bollinger: `- \`{"type":"bollinger","timeframe":"1h","period":20,"sigma":2,"band":"upper"|"lower"}\` 終値がボリンジャーバンド（N 本・Kσ、中央は単純移動平均）の上限以上・下限以下。本数 ${LIMITS.bollingerPeriod.min}〜${LIMITS.bollingerPeriod.max}、σ ${LIMITS.bollingerSigma.min}〜${LIMITS.bollingerSigma.max}（0.1 刻み）`,
	adx: `- \`{"type":"adx","timeframe":"1h","period":14,"threshold":20,"direction":"above"|"below"}\` ADX（Wilder 方式、高値・安値・終値で計算）が N 以上・以下。トレンドの強さだけを見て向きは見ないので、向きは EMA・RSI の条件と組み合わせる。判定に 2 × 期間 + 1 本の足が要る。期間 ${LIMITS.adxPeriod.min}〜${LIMITS.adxPeriod.max}、しきい値 ${LIMITS.adxThreshold.min}〜${LIMITS.adxThreshold.max} の整数`,
	entryChange: `- \`{"type":"entryChange","percent":2,"direction":"up"|"down"}\` 現在値がそのロットの買値から N% 以上上がった・下がった。売りのグループ（partialTakeProfit・takeProfit・stopLoss）だけ。${LIMITS.percent.min}〜${LIMITS.percent.max}`,
	trailingStop: `- \`{"type":"trailingStop","percent":3,"activatePercent":0}\` 現在値がそのロットを買ってからの最高値から N% 以上下がった。最高値が買値から activatePercent% 以上になるまでは成立しない（0 は買った直後から、${LIMITS.trailingActivatePercent.min}〜${LIMITS.trailingActivatePercent.max}、0.1 刻み）。売りのグループだけ。${LIMITS.percent.min}〜${LIMITS.percent.max}`,
	entryAtr: `- \`{"type":"entryAtr","timeframe":"1h","period":14,"multiple":2,"direction":"up"|"down"}\` 現在値がそのロットの買値から、買った時点の ATR（Wilder 方式、timeframe の足で period 本）の multiple 倍以上上がった・下がった。ATR は約定した足の1本前までの確定した足で求め、ロットを持つ間は変えない。売りのグループだけ。period ${LIMITS.atrPeriod.min}〜${LIMITS.atrPeriod.max} の整数、multiple ${LIMITS.atrMultiple.min}〜${LIMITS.atrMultiple.max}（0.1 刻み）`,
	trailingAtr: `- \`{"type":"trailingAtr","timeframe":"1h","period":14,"multiple":3,"activateMultiple":0}\` 現在値がそのロットを買ってからの最高値から、買った時点の ATR の multiple 倍以上下がった。最高値の求め方は trailingStop と同じ。最高値が買値から ATR の activateMultiple 倍以上になるまでは成立しない（0 は買った直後から、${LIMITS.atrActivateMultiple.min}〜${LIMITS.atrActivateMultiple.max}、0.1 刻み）。売りのグループだけ。period・multiple は entryAtr と同じ`,
	holdingBars: `- \`{"type":"holdingBars","timeframe":"1h","bars":24}\` そのロットの買いの約定から、timeframe の足で N 本ぶんの時間が経った（足のデータは使わず時間で数える）。売りのグループだけ。${LIMITS.holdingBars.min}〜${LIMITS.holdingBars.max}`,
	eventWindow: `- \`{"type":"eventWindow","minImportance":"high","beforeHours":0,"afterHours":24,"allowNoCalendar":false}\` 判定の時刻 t について、[t − afterHours 時間, t + beforeHours 時間] に重要度が minImportance 以上の予定が無い（予定の afterHours 時間後までと beforeHours 時間前からは買わない）。minImportance は high（高）・medium（中以上）・low（すべての予定）。予定は設定の取得元（iCal）から取得したものと、アプリが持つ 2022〜2026 年の FOMC 声明・議事要旨・米 CPI・米雇用統計・日銀会合で、重要度は予定の評価基準（設定の「ニュース」の「予定」）で AI が判断する。終日の予定は JST の日の 0:00〜24:00 を予定の時間とする。暦がそろっていない期間に掛かるか、重要度が未判断の予定に掛かる判定（暦切れ）では、allowNoCalendar が true なら成立とみなし、false なら買いを判定しない。買いのグループだけ。beforeHours・afterHours は ${LIMITS.eventHours.min}〜${LIMITS.eventHours.max} の整数`,
	judgment: `- \`{"type":"judgment","judge":"sentiment"|"risk","values":[...]}\` ニュースの市場評価（センチメント・リスク）が values のどれか。values は sentiment: ${values("sentiment")}（BTC の価格にとって強気材料か弱気材料か）、risk: ${values("risk")}（画面の名前を括弧に添えた）。どの判定でも ${NO_JUDGMENT}（データなし＝採点の記録が始まる前）を足せる。データなしのとき ${NO_JUDGMENT} を含まない条件は満たさない。記録開始前を含む期間のバックテストは、判定の条件のどれかに ${NO_JUDGMENT} があるときだけ実行できる`,
};

/** 値と画面の名前の対応。例: +2（かなり強気） */
function values(j: Judge): string {
	return JUDGMENT_VALUES[j]
		.map((v) => `${v}（${JUDGMENT_VALUE_LABELS[v]}）`)
		.join("/");
}

export function conditionSetGuide(): string {
	const templates = TEMPLATE_IDS.map((id) => {
		const t = strategyTemplate(id);
		return `### ${t.name}（${id}）\n${t.description}\n\`\`\`json\n${JSON.stringify(t.params, null, 2)}\n\`\`\``;
	});
	return [
		"# 条件セット（戦略の params）の書き方",
		"",
		"戦略とバックテストは同じ条件セットを使う。画面の「戦略」の項目と1対1で対応する。",
		"",
		"## 値の単位",
		"- 金額は円の整数。BTC の数量は satoshi（1e-8 BTC）の整数",
		"- 時刻は道具の出力では JST の ISO 8601。入力は ISO 8601（タイムゾーン付き）か `YYYY-MM-DD`（JST の 0:00）",
		"",
		"## 項目",
		`- frequency.flat / frequency.holding: 保有なし・保有中のときの判定の間隔。\`{"value":1,"unit":"h"}\`（value ${LIMITS.frequency.min}〜${LIMITS.frequency.max}、unit は s/m/h）`,
		`- dailyLossLimit: 1日（JST）の確定損失の上限（円、${LIMITS.dailyLossLimit.min}〜${LIMITS.dailyLossLimit.max}）。達したら翌 0:00 まで新しい買いを止める`,
		`- stopLossCooldownBars / stopLossCooldownTimeframe: 損切り（建値ストップを含む）の売りを出してから、stopLossCooldownTimeframe の足でこの本数ぶんの時間は、どの買いも新しい買いを止める（${LIMITS.stopLossCooldownBars.min}〜${LIMITS.stopLossCooldownBars.max}、0 は止めない）。自動取引をオンにし直すと損切りの時刻を忘れる`,
		`- buys: 買い（${LIMITS.buys.min}〜${LIMITS.buys.max}個）。上ほど優先し、同じ判定で複数の買いが成立したら、買えるもののうち上の1つだけ注文する。ロットは買った買いの partialTakeProfit・takeProfit・stopLoss で売る。各要素は次の項目を持つ`,
		"- buys[].id: 買いの id（戦略の中で重ならない文字列。b1, b2 …）。ロットと注文はこの id で買いを指すので、既存の買いの id は変えない",
		`- buys[].name: 買いの名前（${LIMITS.buyName.min}〜${LIMITS.buyName.max}文字、ほかの買いと重ならない）。買いが2つ以上なら判断の理由と注文に出る`,
		`- buys[].orderSize: 1回の注文量（satoshi、${LIMITS.orderSize.min}〜${LIMITS.orderSize.max}）。約定した買い1件がこの量の1ロット`,
		`- buys[].maxPositions: この買いで同時に持てるロットの数（${LIMITS.maxPositions.min}〜${LIMITS.maxPositions.max}）。この買いの未約定の買いも数える`,
		'- buys[].buy / partialTakeProfit / takeProfit / stopLoss: 条件のグループ。`{"match":"all"|"any","conditions":[...]}`。buy と stopLoss は1つ以上必要、partialTakeProfit・takeProfit は空でもよい',
		`- buys[].partialSell: 一部利確の売り方。\`{"percent":50,"breakevenStop":true}\`。partialTakeProfit が成立したロットの percent%（${LIMITS.partialSellPercent.min}〜${LIMITS.partialSellPercent.max} の整数、1 satoshi 未満は切り捨て）を売る。1ロットにつき1回だけ。売る量と残りはどちらも orderSize の下限以上にする。breakevenStop が true なら、一部利確の後に現在値が買値を下回ったら残りを損切りとして売る。partialTakeProfit が空なら使わない`,
		`- buys[].buyOrder: 買い注文の出し方。\`{"lines":[{"type":"limit","belowPercent":0.1}],"expireBars":3,"expireTimeframe":"1h"}\`。行は ${LIMITS.buyOrderLines.min}〜${LIMITS.buyOrderLines.max} 行で、条件成立で行の数だけ同時に出す。\`{"type":"market"}\`（成行）は先頭の1行だけ。指値は現在値から belowPercent % 下（0 以上 100 未満、0.01 刻み）で、下の行ほど大きい %。expireTimeframe の足で expireBars（${LIMITS.buyExpireBars.min}〜${LIMITS.buyExpireBars.max}）本ぶんの時間のあいだ約定しなければ取消`,
		"- 売りは常に成行で、ロットごとに判定する。同時に成り立てば 損切り（建値ストップを含む）> 利確 > 一部利確 の順で1つだけ出す。一部利確の売りと残りの売りは、成績では買い1件ごとに1往復にまとめる",
		"",
		"## 条件",
		`EMA・RSI・ボリンジャーバンド・直近の高値安値・ATR・買ってからの本数の条件は timeframe（${TIMEFRAMES.join(" / ")}）を持ち、本数はその足で数える。条件ごとに違う足を選べる（例: 1時間足の RSI で買い、日足の EMA 200 より上のときだけに絞る）。判定のときは、確定した足に今の途中の足（判定時点までの値動きから作る）を足して計算する`,
		...Object.values(CONDITIONS),
		"",
		"## バックテストの既定",
		`- 手数料率は ppm（100 万分率）。既定は指値 ${DEFAULT_FEE_RATES.limitPpm}・成行 ${DEFAULT_FEE_RATES.marketPpm}（Coincheck の取引所の BTC/JPY と同じ）`,
		"- 使える期間と粒度は get_data_coverage で確かめる。期間より前の足も指標の計算に使う（EMA・RSI・ATR・ADX は始めの値の影響が 0.25% 以下になる本数を足す。EMA 200 は800本、RSI 14 は96本。ボリンジャーバンドは本数ぶん）",
		"",
		"## ひな形",
		...templates,
	].join("\n");
}
