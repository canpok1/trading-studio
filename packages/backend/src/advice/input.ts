// アドバイスで AI に渡すバックテストの資料を文章にする。値動きは戦略が参照する足で渡し、多すぎるときは絞る

import type { BacktestOrder, Timeframe } from "@trading-studio/core";
import {
	candleStart,
	coarserTimeframes,
	JUDGE_LABELS,
	JUDGES,
	JUDGMENT_VALUE_LABELS,
	satoshiToBtcString,
	TIMEFRAME_LABELS,
	TIMEFRAME_MS,
} from "@trading-studio/core";
import type { BacktestChart, BacktestRun } from "../backtests/types";
import type { JudgmentSeries } from "../judgments/types";

/** AI に渡す足の上限。1分足で1か月を回すと約4.3万本になり、一度に渡すには多すぎる */
export const MAX_BARS = 3_000;
/** 足が多すぎるとき、注文の前後に戦略の足で渡す本数（片側） */
export const ORDER_WINDOW_BARS = 10;

type Bar = BacktestChart["bars"][number];

export type AdviceSource = {
	run: BacktestRun;
	bars: Bar[];
	orders: BacktestOrder[];
	/** 判定の条件を使う戦略だけ渡す */
	judgments: JudgmentSeries | null;
};

function jst(time: number): string {
	return new Date(time + 9 * 3_600_000)
		.toISOString()
		.slice(0, 16)
		.replace("T", " ");
}

/** 理由の文言は金額の3桁区切りを含むので、表を崩さないよう区切りの文字を置き換える */
const cell = (text: string) => text.replace(/[,\n]/g, " ");
const yen = (v: number | null) => (v === null ? "" : String(v));
const pct = (ppm: number) => `${ppm / 10_000}%`;
/** 率は小数2桁までにする。桁が多いと AI への資料が読みにくい */
const r2 = (v: number) => Math.round(v * 100) / 100;

/** 注文にかかわる時刻（発注・約定・取消） */
function orderTimes(orders: BacktestOrder[]): number[] {
	return orders
		.flatMap((o) => [o.placedAt, o.filledAt, o.canceledAt])
		.filter((t): t is number => t !== null);
}

/** 時刻を含む足の添字。範囲外は端に寄せる */
function barIndex(bars: Bar[], time: number): number {
	let lo = 0;
	let hi = bars.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if ((bars[mid] as Bar).time <= time) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** 足を粗い粒度にまとめる。4本値の無い古い実行は終値だけで作る */
export function aggregateBars(bars: Bar[], timeframe: Timeframe): Bar[] {
	const out: Bar[] = [];
	for (const b of bars) {
		const t = candleStart(b.time, timeframe);
		const last = out.at(-1);
		if (last?.time !== t) {
			out.push({ ...b, time: t });
			continue;
		}
		last.close = b.close;
		if (last.high !== undefined && b.high !== undefined) {
			last.high = Math.max(last.high, b.high);
		}
		if (last.low !== undefined && b.low !== undefined) {
			last.low = Math.min(last.low, b.low);
		}
	}
	return out;
}

export type BarSelection =
	| { kind: "all"; bars: Bar[] }
	| {
			kind: "reduced";
			overviewTimeframe: Timeframe;
			overview: Bar[];
			/** 注文の前後の足（戦略の足）。連続しない区間ごと */
			windows: Bar[][];
			windowBars: number;
			/** 上限に収まらず、前後の足を渡せなかった注文の時刻がある */
			truncated: boolean;
	  };

/**
 * 渡す足を選ぶ。上限を超えるときは、全体を上限の半分に収まる粗さの足にまとめ、
 * 残りの枠で注文の前後だけ戦略の足で渡す
 */
export function selectBars(
	bars: Bar[],
	timeframe: Timeframe,
	orders: BacktestOrder[],
	maxBars = MAX_BARS,
	windowBars = ORDER_WINDOW_BARS,
): BarSelection {
	if (bars.length <= maxBars) return { kind: "all", bars };
	const coarser = coarserTimeframes(timeframe);
	let overviewTimeframe = coarser.at(-1) ?? timeframe;
	let overview = aggregateBars(bars, overviewTimeframe);
	for (const tf of coarser) {
		const a = aggregateBars(bars, tf);
		if (a.length <= maxBars / 2) {
			overviewTimeframe = tf;
			overview = a;
			break;
		}
	}
	const budget = Math.max(0, maxBars - overview.length);
	const centers = [
		...new Set(orderTimes(orders).map((t) => barIndex(bars, t))),
	].sort((a, b) => a - b);

	const pick = (w: number) => {
		const idx: number[] = [];
		for (const c of centers) {
			const from = Math.max(c - w, idx.length ? (idx.at(-1) as number) + 1 : 0);
			for (let i = from; i <= Math.min(c + w, bars.length - 1); i++)
				idx.push(i);
		}
		return idx;
	};
	let w = windowBars;
	let idx = pick(w);
	while (idx.length > budget && w > 0) {
		w = Math.floor(w / 2);
		idx = pick(w);
	}
	const truncated = idx.length > budget;
	if (truncated) idx = idx.slice(0, budget);

	const windows: Bar[][] = [];
	let prev = -2;
	for (const i of idx) {
		if (i !== prev + 1) windows.push([]);
		windows.at(-1)?.push(bars[i] as Bar);
		prev = i;
	}
	return {
		kind: "reduced",
		overviewTimeframe,
		overview,
		windows,
		windowBars: w,
		truncated,
	};
}

/** 足の表。判定を渡すときは、その足の終わりの時刻の判定を列に足す */
function barTable(
	bars: Bar[],
	step: number,
	judgments: JudgmentSeries | null,
): string {
	const head = ["時刻(JST)", "始値", "高値", "安値", "終値"];
	if (judgments) head.push(...JUDGES.map((j) => `${JUDGE_LABELS[j]}判定`));
	const rows = bars.map((b) => {
		const cols = [
			jst(b.time),
			yen(b.open ?? null),
			yen(b.high ?? null),
			yen(b.low ?? null),
			String(b.close),
		];
		if (judgments) {
			// 粗い足にまとめたときは、その足の最後の判定を使う。期間の終わりが粗い足の途中なら、期間の最後の判定
			const k = Math.min(
				Math.floor(
					(b.time + step - judgments.step - judgments.from) / judgments.step,
				),
				judgments.values.trend.length - 1,
			);
			for (const j of JUDGES) {
				const v = judgments.values[j][k] ?? null;
				cols.push(v === null ? "" : (JUDGMENT_VALUE_LABELS[v] ?? v));
			}
		}
		return cols.join(",");
	});
	return [head.join(","), ...rows].join("\n");
}

function orderTable(orders: BacktestOrder[]): string {
	const head = [
		"ID",
		"売買",
		"注文方法",
		"指値(円)",
		"数量(BTC)",
		"発注(JST)",
		"状態",
		"約定(JST)",
		"約定価格(円)",
		"手数料(円)",
		"取消(JST)",
		"取消の理由",
		"往復の損益(円)",
		"発注の理由",
	];
	const rows = orders.map((o) =>
		[
			o.id,
			o.side === "buy" ? "買い" : "売り",
			o.type === "limit" ? "指値" : "成行",
			yen(o.price),
			satoshiToBtcString(o.quantity),
			jst(o.placedAt),
			o.status === "filled"
				? "約定"
				: o.status === "canceled"
					? "取消"
					: "注文中",
			o.filledAt === null ? "" : jst(o.filledAt),
			yen(o.fillPrice),
			yen(o.fee),
			o.canceledAt === null ? "" : jst(o.canceledAt),
			cell(o.cancelReason ?? ""),
			yen(o.pnl),
			cell(o.reason),
		].join(","),
	);
	return [head.join(","), ...rows].join("\n");
}

/** AI に渡す資料 */
export function buildAdviceSource(
	{ run, bars, orders, judgments }: AdviceSource,
	maxBars = MAX_BARS,
): string {
	const s = run.summary;
	const tf = run.timeframe;
	const step = TIMEFRAME_MS[tf];
	const lines: string[] = [];
	lines.push("## 実行の条件");
	lines.push(`- 期間: ${jst(run.from)} 〜 ${jst(run.to)}（終わりは含まない）`);
	lines.push(`- 戦略の足: ${TIMEFRAME_LABELS[tf]}`);
	lines.push(
		`- 判定と約定に使った足: ${TIMEFRAME_LABELS[run.stepTimeframe]}${run.stepLimited ? "（細かい過去データが無く、判定頻度より粗い間隔でしか判定できなかった）" : ""}`,
	);
	lines.push(`- 初期資金: ${run.initialCash} 円`);
	lines.push(
		`- 手数料率: 指値 ${pct(run.fees.limitPpm)}・成行 ${pct(run.fees.marketPpm)}`,
	);
	lines.push("");
	lines.push("## 戦略のパラメータ（JSON）");
	lines.push(
		"単位: orderSize は satoshi（1e-8 BTC）、dailyLossLimit は円、percent は %、fast・slow・lookback・expireBars は戦略の足の本数。改善案もこの項目名で書く",
	);
	lines.push(JSON.stringify(run.params));
	if (run.aggregationRule && judgments) {
		lines.push("");
		lines.push("## AI 判定の集計ルール（JSON）");
		lines.push(JSON.stringify(run.aggregationRule));
	}
	if (s) {
		lines.push("");
		lines.push("## 成績");
		lines.push(
			`- 最終資金: ${s.finalEquity} 円（損益 ${s.pnl} 円、${r2(s.pnlPercent)}%）`,
		);
		lines.push(`- 同期間のガチホ: ${r2(s.buyAndHoldPercent)}%`);
		lines.push(
			`- 往復の取引: ${s.trades} 回（勝ち ${s.wins}・負け ${s.losses}）`,
		);
		lines.push(
			`- 勝率: ${s.winRate === null ? "取引なし" : `${r2(s.winRate)}%`}`,
		);
		lines.push(
			`- 損益比率: ${s.profitFactor === null ? "損失なし" : r2(s.profitFactor)}`,
		);
		lines.push(
			`- 最大ドローダウン: ${r2(s.maxDrawdownPercent)}%${s.maxDrawdownFrom !== null && s.maxDrawdownTo !== null ? `（${jst(s.maxDrawdownFrom)} 〜 ${jst(s.maxDrawdownTo)}）` : ""}`,
		);
		lines.push(
			`- 平均保有期間: ${s.averageHoldingMs === null ? "取引なし" : `${Math.round(s.averageHoldingMs / 60_000)} 分`}`,
		);
		lines.push(
			`- 期間の最後に持っていた数量: ${satoshiToBtcString(s.openPositionQuantity)} BTC`,
		);
	}
	lines.push("");
	lines.push(`## 注文（${orders.length} 件、古い順）`);
	lines.push(orderTable(orders));

	const sel = selectBars(bars, tf, orders, maxBars);
	lines.push("");
	if (sel.kind === "all") {
		lines.push(`## 値動き（${TIMEFRAME_LABELS[tf]}、${sel.bars.length} 本）`);
		lines.push(barTable(sel.bars, step, judgments));
	} else {
		lines.push(
			`## 値動きの全体（${TIMEFRAME_LABELS[sel.overviewTimeframe]}、${sel.overview.length} 本）`,
		);
		lines.push(
			`戦略の足では ${bars.length} 本あり多すぎるため、全体は粗い足にまとめ、注文の前後だけ戦略の足で下に載せる`,
		);
		lines.push(
			barTable(sel.overview, TIMEFRAME_MS[sel.overviewTimeframe], judgments),
		);
		lines.push("");
		lines.push(
			`## 注文の前後の値動き（${TIMEFRAME_LABELS[tf]}、注文の前後 ${sel.windowBars} 本ずつ）`,
		);
		if (sel.truncated) {
			lines.push(
				"注文が多く上限に収まらないため、古い注文の前後から載せられる分だけ載せる",
			);
		}
		for (const w of sel.windows) lines.push(barTable(w, step, judgments), "");
	}
	return lines.join("\n").trimEnd();
}
