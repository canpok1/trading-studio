// MCP で Claude に渡す、条件セット（戦略の params）の書き方。画面の項目と JSON の対応を伝える

import type { ConditionType } from "@trading-studio/core";
import {
	DEFAULT_FEE_RATES,
	JUDGMENT_VALUES,
	LIMITS,
	strategyTemplate,
	TEMPLATE_IDS,
	TIMEFRAMES,
} from "@trading-studio/core";

// Record にしておき、条件の種類を足したら型エラーでここの書き足しに気づけるようにする
const CONDITIONS: Record<ConditionType, string> = {
	emaCross: `- \`{"type":"emaCross","fast":12,"slow":48,"direction":"up"|"down"}\` 短期 EMA が長期 EMA を前の足から今の足の間に上抜け・下抜けた。本数 ${LIMITS.emaPeriod.min}〜${LIMITS.emaPeriod.max}、fast < slow`,
	breakout: `- \`{"type":"breakout","lookback":20,"direction":"high"|"low"}\` 終値が今の足を除く直近 N 本の最高値を上回った・最安値を下回った。本数 ${LIMITS.lookback.min}〜${LIMITS.lookback.max}`,
	rsi: `- \`{"type":"rsi","period":14,"threshold":30,"direction":"above"|"below"}\` RSI（Wilder 方式）が N 以上・以下。期間 ${LIMITS.rsiPeriod.min}〜${LIMITS.rsiPeriod.max}、しきい値 ${LIMITS.rsiThreshold.min}〜${LIMITS.rsiThreshold.max} の整数`,
	entryChange: `- \`{"type":"entryChange","percent":2,"direction":"up"|"down"}\` 現在値がそのロットの買値から N% 以上上がった・下がった。売りのグループ（takeProfit・stopLoss）だけ。${LIMITS.percent.min}〜${LIMITS.percent.max}`,
	judgment: `- \`{"type":"judgment","judge":"trend"|"risk"|"sentiment","values":[...]}\` ニュースの AI 判定が values のどれか。values は trend: ${JUDGMENT_VALUES.trend.join("/")}、risk: ${JUDGMENT_VALUES.risk.join("/")}、sentiment: ${JUDGMENT_VALUES.sentiment.join("/")}`,
};

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
		`- timeframe: 足の粒度（${TIMEFRAMES.join(" / ")}）。EMA・RSI の本数・直近 N 本・指値の取消までの本数はこの足で数える`,
		`- frequency.flat / frequency.holding: ポジションなし・ありのときの判定の間隔。\`{"value":1,"unit":"h"}\`（value ${LIMITS.frequency.min}〜${LIMITS.frequency.max}、unit は s/m/h）`,
		`- orderSize: 1回の注文量（satoshi、${LIMITS.orderSize.min}〜${LIMITS.orderSize.max}）。約定した買い1件がこの量の1ロット`,
		`- maxPositions: 同時に持てるロットの数（${LIMITS.maxPositions.min}〜${LIMITS.maxPositions.max}）。未約定の買いも数える`,
		`- dailyLossLimit: 1日（JST）の確定損失の上限（円、${LIMITS.dailyLossLimit.min}〜${LIMITS.dailyLossLimit.max}）。達したら翌 0:00 まで新しい買いを止める`,
		'- buy / takeProfit / stopLoss: 条件のグループ。`{"match":"all"|"any","conditions":[...]}`。buy と stopLoss は1つ以上必要、takeProfit は空でもよい',
		`- buyOrder: 買い注文の出し方。\`{"lines":[{"type":"limit","belowPercent":0.1}],"expireBars":3}\`。行は ${LIMITS.buyOrderLines.min}〜${LIMITS.buyOrderLines.max} 行で、条件成立で行の数だけ同時に出す。\`{"type":"market"}\`（成行）は先頭の1行だけ。指値は現在値から belowPercent % 下（0 以上 100 未満、0.01 刻み）で、下の行ほど大きい %。expireBars（${LIMITS.buyExpireBars.min}〜${LIMITS.buyExpireBars.max}）本のあいだ約定しなければ取消`,
		"- 売りは常に成行で、ロットごとに判定する。利確と損切りが同時に成り立てば損切りを優先する",
		"",
		"## 条件",
		...Object.values(CONDITIONS),
		"",
		"## バックテストの既定",
		`- 手数料率は ppm（100 万分率）。既定は指値 ${DEFAULT_FEE_RATES.limitPpm}・成行 ${DEFAULT_FEE_RATES.marketPpm}（0.1%）`,
		"- 使える期間と粒度は get_data_coverage で確かめる。期間より前の足も指標の計算に使う（EMA・RSI は本数の10倍）",
		"",
		"## ひな形",
		...templates,
	].join("\n");
}
