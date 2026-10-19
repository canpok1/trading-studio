// 戦略の見張り。今の価格で条件セットを試算し、条件ごとの成立と、価格がいくらになれば成立するか（発動価格）を求める。
// 判定（evaluateConditionSet）と同じ材料で計算するが、state は変えず注文も出さない

import type {
	BuyRule,
	Condition,
	ConditionGroup,
	ConditionSet,
	Ctx,
	SellGroupKey,
	Series,
} from "./condition-strategy";
import {
	adxOf,
	buyRuleOf,
	checkCondition,
	emaOf,
	entryAtrLine,
	formatRsi,
	latestJudgments,
	lotAtrOf,
	lotEntryAtrs,
	lotPeaks,
	needsCandles,
	partialSellQuantity,
	prevBuyHits,
	prevStopLossAt,
	rsiOf,
	seriesOf,
	trailingAtrLines,
	usesAtr,
	usesPeaks,
} from "./condition-strategy";
import { dvolAt, dvolAverage, dvolRatioPercent, formatDvol } from "./dvol";
import type { ScheduledEvent } from "./event-calendar";
import {
	calendarGap,
	eventsBetween,
	HOUR_MS,
	jstDateTime,
	nextEvent,
} from "./event-calendar";
import { formatYen } from "./format";
import { bollinger } from "./indicators";
import { limitBuyPriceBelow, notionalYen } from "./money";
import { JUDGMENT_VALUE_LABELS, NO_JUDGMENT } from "./news-judgment";
import type { StrategyInput } from "./strategy";
import type { Timeframe } from "./timeframe";
import { candleStart, TIMEFRAME_MS } from "./timeframe";
import type { Candle } from "./types";

/** 発動価格を探す範囲。今の価格からこの割合の上下まで */
export const WATCH_RANGE = 0.5;

export type WatchCondition = {
	condition: Condition;
	/** 今の価格で成立しているか。指標の本数が足りなければ null */
	met: boolean | null;
	/** 今の値（例: 「今 46.2」「EMA 12,540,000」）。本数が足りなければその旨 */
	detail: string;
	/**
	 * 成立・不成立が入れ替わる価格。metAbove はその価格以上で成立するか（false ならその価格以下で成立する）。
	 * 価格では変わらない条件と、探す範囲で入れ替わらない条件は null
	 */
	edge: { price: number; metAbove: boolean } | null;
};

export type WatchGroup = {
	match: ConditionGroup["match"];
	conditions: WatchCondition[];
	/** 今の価格でグループが成立しているか。条件が空なら false、本数が足りなければ null */
	met: boolean | null;
	/**
	 * 今は不成立で、ほかの条件はそのままに価格だけが届けばグループが成立する価格（発動価格）。
	 * 価格では成立しない・成立済みなら空
	 */
	triggers: number[];
};

/** 買いが次の判定で買わない理由。ready は買える（条件が成立すれば注文する） */
export type WatchBuyStatus =
	| { kind: "ready" }
	| { kind: "waitingFill" }
	| { kind: "full" }
	| { kind: "cooldown"; barsLeft: number; timeframe: Timeframe }
	| { kind: "continuing" }
	| { kind: "blocked"; reason: string }
	| { kind: "noCash" }
	| { kind: "insufficient"; reason: string }
	| { kind: "noCalendar"; reason: string };

export type WatchLot = {
	id: string;
	entryPrice: number;
	quantity: number;
	/** 売りの注文の約定待ち。待っている間は判定しないので groups は null */
	selling: boolean;
	groups: Record<SellGroupKey, WatchGroup | null> | null;
	/** 建値ストップが効いていれば買値（この価格を下回れば残りを損切り）。効いていなければ null */
	breakeven: number | null;
	/** 一部利確済みか */
	partialDone: boolean;
};

export type WatchBuy = {
	id: string;
	name: string;
	maxPositions: number;
	/** この買いの保有ロット数 */
	holding: number;
	status: WatchBuyStatus;
	buy: WatchGroup;
	lots: WatchLot[];
};

export type WatchActionKind =
	| "entry"
	| "partialTakeProfit"
	| "takeProfit"
	| "stopLoss";

/** 次に起きうる売買。price が null なら今の価格のまま次の判定で起きる */
export type WatchAction = {
	kind: WatchActionKind;
	price: number | null;
	buyId: string;
	buyName: string;
	lotId: string | null;
};

/** 次の動きのきっかけ */
export type WatchTrigger =
	/** 全条件が成立していて次の判定で起きる */
	| { kind: "now" }
	/** 出している注文。成行なら price は null */
	| { kind: "order"; price: number | null }
	/** 価格がここまで動けば全条件が揃う */
	| { kind: "price"; price: number }
	/** 残り1つの保有本数の条件。あと何本で揃うか */
	| { kind: "bars"; bars: number; timeframe: Timeframe }
	/** 残り1つの予定の前後の条件。この時刻に明ける */
	| { kind: "time"; at: number }
	/** 残り1つの、価格で求められない条件（市場評価・DVOL など） */
	| { kind: "condition"; condition: Condition; detail: string }
	/** 未成立の条件が2つ以上。価格の条件は揃う価格が1つあれば1つと数える */
	| { kind: "remaining"; count: number };

/** 次の動き1つ。行動（買いごとの 買い・一部利確・利確・損切り）ごとに一番優先度の高いきっかけ1つ */
export type WatchMove = {
	/** sell は出している売りの注文（利確・損切りのどちらの注文かは持たない） */
	kind: WatchActionKind | "sell";
	buyId: string;
	buyName: string;
	trigger: WatchTrigger;
};

export type StrategyWatch = {
	price: number;
	buys: WatchBuy[];
	/** 次に起きうる売買。発動価格のあるものと、次の判定で起きるもの */
	actions: WatchAction[];
	/** 次の動き。優先度の高い順 */
	moves: WatchMove[];
};

export type WatchInput = Omit<StrategyInput<ConditionSet>, "position"> & {
	/** 1日の損失上限などで新しい買いを止めているときの理由。止めていなければ null */
	buyBlocked: string | null;
};

const signed = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;

/**
 * 最後の足が今の時刻より前に終わっている（今の足の1分足がまだ無い）なら、今の価格だけの途中の足を足す。
 * 発動価格は最後の足の終値を置き換えて求めるので、確定した足を書き換えないようにする
 */
function withForming(
	candles: readonly Candle[],
	tf: Timeframe,
	now: number,
	price: number,
): readonly Candle[] {
	const last = candles.at(-1);
	if (!last || last.time + TIMEFRAME_MS[tf] >= now) return candles;
	return [
		...candles,
		{
			time: candleStart(now, tf),
			open: price,
			high: price,
			low: price,
			close: price,
			volume: 0,
		},
	];
}

/** 足の最後（途中の足）の終値を x にした足 */
function withClose(candles: readonly Candle[], x: number): Candle[] {
	const last = candles.at(-1);
	if (!last) return [];
	return [
		...candles.slice(0, -1),
		{
			...last,
			close: x,
			high: Math.max(last.high, x),
			low: Math.min(last.low, x),
		},
	];
}

/** 今の価格を x に置き換えた判定の材料。足ごとの最後の足の終値も x にする */
function ctxAt(base: Ctx, x: number): Ctx {
	const cache = new Map<Timeframe, Series>();
	return {
		...base,
		price: x,
		series: (tf) => {
			let v = cache.get(tf);
			if (!v) {
				v = seriesOf(withClose(base.series(tf).candles, x));
				cache.set(tf, v);
			}
			return v;
		},
	};
}

const isMet = (c: Condition, ctx: Ctx): boolean | null => {
	const h = checkCondition(c, ctx);
	return "insufficient" in h ? null : h.ok;
};

/** 成立・不成立が入れ替わる価格を、今の価格から上下 WATCH_RANGE の範囲で二分法で探す */
function edgeOf(
	c: Condition,
	ctx: Ctx,
	metNow: boolean,
): WatchCondition["edge"] {
	const p = ctx.price;
	const lo = Math.max(1, Math.floor(p * (1 - WATCH_RANGE)));
	const hi = Math.ceil(p * (1 + WATCH_RANGE));
	const at = (x: number) => isMet(c, ctxAt(ctx, x)) ?? metNow;
	const metLo = at(lo);
	const metHi = at(hi);
	// 片側だけで入れ替わるときだけ探す（両側で入れ替わる・入れ替わらない条件は価格の線にしない）
	let far: number;
	if (metHi !== metNow && metLo === metNow) far = hi;
	else if (metLo !== metNow && metHi === metNow) far = lo;
	else return null;
	let a = p;
	let b = far;
	while (Math.abs(b - a) > 1) {
		const mid = Math.round((a + b) / 2);
		if (at(mid) === metNow) a = mid;
		else b = mid;
	}
	const metAbove = far === hi ? !metNow : metNow;
	// 成立する側の端を返す
	return { price: metAbove ? Math.max(a, b) : Math.min(a, b), metAbove };
}

/** 条件の今の値 */
function detailOf(c: Condition, ctx: Ctx): string {
	if (c.type === "judgment") {
		const v = ctx.judgments[c.judge] ?? NO_JUDGMENT;
		return `今 ${JUDGMENT_VALUE_LABELS[v] ?? v}`;
	}
	if (c.type === "entryChange") {
		if (!ctx.lot) return "";
		return `買値から ${signed((ctx.price / ctx.lot.entryPrice - 1) * 100)}`;
	}
	if (c.type === "trailingStop") {
		if (!ctx.lot) return "";
		const { peak, entryPrice } = ctx.lot;
		const rise = (peak / entryPrice - 1) * 100;
		if (c.activatePercent > 0 && rise < c.activatePercent) {
			return `未発動・最高値 ${signed(rise)}`;
		}
		return `最高値 ${formatYen(peak)} 円から ${signed((ctx.price / peak - 1) * 100)}`;
	}
	if (c.type === "holdingBars") {
		if (!ctx.lot) return "";
		const bars = Math.floor(
			(ctx.now - ctx.lot.openedAt) / TIMEFRAME_MS[c.timeframe],
		);
		return `${bars} 本経過`;
	}
	if (c.type === "eventWindow") return eventWindowDetail(c, ctx);
	if (c.type === "dvol" || c.type === "dvolAverage") {
		const v = dvolAt(ctx.dvol, ctx.now);
		if (!v.ok) return v.reason;
		if (c.type === "dvol") return `今 ${formatDvol(v.value)}`;
		const avg = dvolAverage(ctx.dvol, ctx.now, c.days);
		if (!avg.ok) return avg.reason;
		return `今 ${formatDvol(v.value)} ・ 平均 ${formatDvol(avg.value)}（${dvolRatioPercent(v.value, avg.value).toFixed(0)}%）`;
	}
	if (!needsCandles(c)) return "";
	const sr = ctx.series(c.timeframe);
	const n = sr.candles.length;
	const h = checkCondition(c, ctx);
	if ("insufficient" in h) return h.insufficient;
	switch (c.type) {
		case "emaCross":
			return `短期 ${formatYen(emaOf(sr, c.fast)[n - 1] as number)} 円 ・ 長期 ${formatYen(emaOf(sr, c.slow)[n - 1] as number)} 円`;
		case "breakout": {
			const window = sr.candles.slice(n - 1 - c.lookback, n - 1);
			return c.direction === "high"
				? `高値 ${formatYen(Math.max(...window.map((x) => x.high)))} 円`
				: `安値 ${formatYen(Math.min(...window.map((x) => x.low)))} 円`;
		}
		case "rsi":
		case "rsiCross":
			return `今 ${formatRsi(rsiOf(sr, c.period)[n - 1] as number)}`;
		case "adx":
			return `今 ${formatRsi(adxOf(sr, c.period)[n - 1] as number)}`;
		case "emaPosition":
			return `EMA ${formatYen(emaOf(sr, c.period)[n - 1] as number)} 円`;
		case "emaSlope": {
			const e = emaOf(sr, c.period);
			const now = e[n - 1] as number;
			const before = e[n - 1 - c.bars] as number;
			return `${c.bars} 本前比 ${signed((now / before - 1) * 100)}`;
		}
		case "bollinger": {
			const b = bollinger(sr.closes, c.period, c.sigma);
			return c.band === "upper"
				? `上限 ${formatYen(b.upper[n - 1] as number)} 円`
				: `下限 ${formatYen(b.lower[n - 1] as number)} 円`;
		}
		case "entryAtr":
		case "trailingAtr": {
			if (!ctx.lot) return "";
			const a = lotAtrOf(c, ctx);
			const { entryPrice, peak } = ctx.lot;
			const atr = `ATR ${formatYen(a.atr)} 円${a.current ? "（今の値）" : ""}`;
			if (c.type === "entryAtr") {
				return `${atr} ・ 基準 ${formatYen(entryAtrLine(c, entryPrice, a.atr))} 円`;
			}
			const t = trailingAtrLines(c, entryPrice, peak, a.atr);
			if (!t.active) {
				return `未発動・最高値 ${formatYen(peak)} 円（発動 ${formatYen(t.activate)} 円）`;
			}
			return `${atr} ・ 基準 ${formatYen(t.line)} 円`;
		}
	}
}

/** 予定の前後に当たっているとき、買えるようになる時刻 */
function eventWindowUntil(
	c: Extract<Condition, { type: "eventWindow" }>,
	ctx: Ctx,
): number {
	const after = c.afterHours * HOUR_MS;
	const before = c.beforeHours * HOUR_MS;
	const hits = eventsBetween(
		ctx.events,
		c.minImportance,
		ctx.now - after,
		ctx.now + before,
	);
	let until = Math.max(ctx.now, ...hits.map((e) => e.end + after));
	// 窓が明ける前に次の予定の前の時間が始まれば、その分も延ばす
	for (;;) {
		const more = eventsBetween(
			ctx.events,
			c.minImportance,
			until - after,
			until + before,
		);
		const next = Math.max(until, ...more.map((e) => e.end + after));
		if (next === until) break;
		until = next;
	}
	return until;
}

/** 当たっている予定と買えるようになる時刻、当たっていなければ次の予定 */
function eventWindowDetail(
	c: Extract<Condition, { type: "eventWindow" }>,
	ctx: Ctx,
): string {
	const h = checkCondition(c, ctx);
	if ("insufficient" in h) return h.insufficient;
	const after = c.afterHours * HOUR_MS;
	const before = c.beforeHours * HOUR_MS;
	const gap = calendarGap(ctx.events, ctx.now - after, ctx.now + before);
	if (h.ok && gap !== null) return `暦切れのため当たらないとみなす（${gap}）`;
	const label = (e: ScheduledEvent) => `「${e.title}」`;
	if (!h.ok) {
		const hits = eventsBetween(
			ctx.events,
			c.minImportance,
			ctx.now - after,
			ctx.now + before,
		);
		return `${[...new Set(hits.map(label))].join("・")}の前後（${jstDateTime(eventWindowUntil(c, ctx))} まで）`;
	}
	const next = nextEvent(ctx.events, c.minImportance, ctx.now);
	return next
		? `次は${label(next)} ${jstDateTime(next.start)}`
		: "暦にこの先の予定なし";
}

function watchGroup(g: ConditionGroup, ctx: Ctx): WatchGroup {
	const conditions: WatchCondition[] = g.conditions.map((c) => {
		const met = isMet(c, ctx);
		return {
			condition: c,
			met,
			detail: detailOf(c, ctx),
			// ADX は今の価格に対して単調でなく、途中の足の高値・安値を超えるまでほぼ動かないので、発動価格を探さない
			edge: met === null || c.type === "adx" ? null : edgeOf(c, ctx, met),
		};
	});
	if (conditions.length === 0) {
		return { match: g.match, conditions, met: false, triggers: [] };
	}
	if (conditions.some((c) => c.met === null)) {
		return { match: g.match, conditions, met: null, triggers: [] };
	}
	const p = ctx.price;
	if (g.match === "any") {
		if (conditions.some((c) => c.met)) {
			return { match: g.match, conditions, met: true, triggers: [] };
		}
		// どれか1つ: 不成立の条件の入れ替わる価格が、それぞれ発動価格になる
		const triggers = conditions
			.flatMap((c) => (c.edge ? [c.edge.price] : []))
			.sort((a, b) => a - b);
		return { match: g.match, conditions, met: false, triggers };
	}
	const met = conditions.every((c) => c.met);
	// すべて満たす: 価格で変わらない条件が全部成立しているときだけ、各条件の成立する範囲の重なりに届く価格を発動価格にする
	if (met || conditions.some((c) => c.edge === null && !c.met)) {
		return { match: g.match, conditions, met, triggers: [] };
	}
	const t = rangeTrigger(conditions, p);
	const triggers = typeof t === "number" ? [t] : [];
	return { match: g.match, conditions, met, triggers };
}

/** 入れ替わる価格のある条件がすべて成立する範囲に届く価格。今の価格が範囲内なら "now"、範囲が無ければ null */
function rangeTrigger(
	conditions: WatchCondition[],
	p: number,
): number | "now" | null {
	let low = 0;
	let high = Number.POSITIVE_INFINITY;
	for (const c of conditions) {
		if (!c.edge) continue;
		if (c.edge.metAbove) low = Math.max(low, c.edge.price);
		else high = Math.min(high, c.edge.price);
	}
	if (low > high) return null;
	return p < low ? low : p > high ? high : "now";
}

/** 価格で求められない条件が残り1つのときのきっかけ */
function conditionTrigger(c: WatchCondition, ctx: Ctx): WatchTrigger {
	const cond = c.condition;
	if (cond.type === "holdingBars" && ctx.lot) {
		const bars = Math.floor(
			(ctx.now - ctx.lot.openedAt) / TIMEFRAME_MS[cond.timeframe],
		);
		return { kind: "bars", bars: cond.bars - bars, timeframe: cond.timeframe };
	}
	if (cond.type === "eventWindow") {
		return { kind: "time", at: eventWindowUntil(cond, ctx) };
	}
	return { kind: "condition", condition: cond, detail: c.detail };
}

/** グループ（行動）のきっかけ。条件が空・判定できないなら null */
function groupTrigger(g: WatchGroup, ctx: Ctx): WatchTrigger | null {
	if (g.conditions.length === 0 || g.met === null) return null;
	if (g.met) return { kind: "now" };
	const p = ctx.price;
	const nearest = (xs: number[]) =>
		[...xs].sort((a, b) => Math.abs(a - p) - Math.abs(b - p))[0];
	if (g.match === "any") {
		// どれか1つ: 1つ揃えば起きるので、一番近い条件だけを見る
		const t = nearest(g.triggers);
		if (t !== undefined) return { kind: "price", price: t };
		const c = g.conditions.find((x) => x.met === false);
		return c ? conditionTrigger(c, ctx) : null;
	}
	const blocking = g.conditions.filter((c) => c.met === false && !c.edge);
	const priced = g.conditions.filter((c) => c.met === false && c.edge);
	const t = rangeTrigger(g.conditions, p);
	// 価格の条件は、全部が揃う価格が1つあれば1つと数える
	const pricedCount =
		priced.length === 0 ? 0 : typeof t === "number" ? 1 : priced.length;
	const remaining = blocking.length + pricedCount;
	if (remaining !== 1) return { kind: "remaining", count: remaining };
	const [only] = blocking;
	if (only) return conditionTrigger(only, ctx);
	return { kind: "price", price: t as number };
}

const TRIGGER_TIER: Record<WatchTrigger["kind"], number> = {
	now: 0,
	order: 1,
	price: 2,
	bars: 3,
	time: 3,
	condition: 4,
	remaining: 5,
};

const KIND_RANK: Record<WatchMove["kind"], number> = {
	sell: 0,
	stopLoss: 0,
	takeProfit: 1,
	partialTakeProfit: 2,
	entry: 3,
};

/**
 * 次の動きの優先度の比較（小さいほど上）。成立 > 注文中 > 価格（幅の小さい順）> 時間 > 価格以外 > あと N 条件（少ない順）。
 * 同じなら 損切り > 利確 > 一部利確 > 買い（判定で同時に成り立ったときの売りの優先と合わせる）
 */
function compareMoves(price: number) {
	const sub = (t: WatchTrigger): number => {
		switch (t.kind) {
			case "order":
				return t.price === null ? 0 : Math.abs(t.price / price - 1);
			case "price":
				return Math.abs(t.price / price - 1);
			case "remaining":
				return t.count;
			default:
				return 0;
		}
	};
	return (a: WatchMove, b: WatchMove) =>
		TRIGGER_TIER[a.trigger.kind] - TRIGGER_TIER[b.trigger.kind] ||
		sub(a.trigger) - sub(b.trigger) ||
		KIND_RANK[a.kind] - KIND_RANK[b.kind];
}

/** 買いが次の判定で買わない理由（evaluateConditionSet の買いの判定と同じ順で見る） */
function buyStatus(
	b: BuyRule,
	input: WatchInput,
	group: WatchGroup,
	opts: {
		openBuys: number;
		free: number;
		cooldownLeft: number | null;
		wasHit: boolean | null;
	},
): WatchBuyStatus {
	const p = input.params;
	if (opts.openBuys > 0) return { kind: "waitingFill" };
	if (opts.free <= 0) return { kind: "full" };
	if (opts.cooldownLeft !== null) {
		return {
			kind: "cooldown",
			barsLeft: opts.cooldownLeft,
			timeframe: p.stopLossCooldownTimeframe,
		};
	}
	if (input.buyBlocked !== null) {
		return { kind: "blocked", reason: input.buyBlocked };
	}
	if (group.met === null) {
		const lacking = group.conditions.find((c) => c.met === null);
		const reason = lacking?.detail ?? "";
		return lacking?.condition.type === "eventWindow"
			? { kind: "noCalendar", reason }
			: { kind: "insufficient", reason };
	}
	// 最大ロット数が 2 以上の買いは、前回の判定で成立していたら一度外れるまで買わない
	// （今外れていれば次の判定で外れたと記録されるので、その後に価格が届けば買う）
	if (b.maxPositions >= 2 && opts.wasHit === true && group.met === true) {
		return { kind: "continuing" };
	}
	// 先頭の注文の額が、未約定の買いを除いた資金で足りるか
	const line = b.buyOrder.lines[0];
	if (line) {
		const at =
			line.type === "market"
				? input.price
				: limitBuyPriceBelow(
						input.price,
						Math.round(line.belowPercent * 10_000),
					);
		const reserved = input.openOrders
			.filter((o) => o.side === "buy")
			.reduce(
				(a, o) => a + notionalYen(o.price ?? input.price, o.quantity, "ceil"),
				0,
			);
		if (input.cash - reserved < notionalYen(at, b.orderSize, "ceil")) {
			return { kind: "noCash" };
		}
	}
	return { kind: "ready" };
}

export function watchConditionSet(input: WatchInput): StrategyWatch {
	const { now, price, candles, lots, openOrders, params: p, state } = input;
	const series = new Map<Timeframe, Series>();
	const ctx: Ctx = {
		series: (tf) => {
			let v = series.get(tf);
			if (!v) {
				v = seriesOf(withForming(candles[tf] ?? [], tf, now, price));
				series.set(tf, v);
			}
			return v;
		},
		price,
		now,
		lot: null,
		judgments: latestJudgments(input.judgments),
		events: input.events,
		dvol: input.dvol,
	};
	const peaks = usesPeaks(p) ? lotPeaks(lots, input.recent, state) : null;
	const entryAtrs = usesAtr(p)
		? lotEntryAtrs(p, lots, ctx.series, state)
		: null;
	const hits = prevBuyHits(state, p);
	const stopLossAt = p.stopLossCooldownBars > 0 ? prevStopLossAt(state) : null;
	const tfMs = TIMEFRAME_MS[p.stopLossCooldownTimeframe];
	const cooldownEnd =
		stopLossAt === null ? null : stopLossAt + p.stopLossCooldownBars * tfMs;
	const cooldownLeft =
		cooldownEnd !== null && now < cooldownEnd
			? Math.ceil((cooldownEnd - now) / tfMs)
			: null;
	const selling = new Set(
		openOrders.filter((o) => o.side === "sell").map((o) => o.lotId),
	);

	const actions: WatchAction[] = [];
	const compare = compareMoves(price);
	// 行動（買い × 種類）ごとに一番優先度の高いきっかけを残す。売りはロットの中で一番のもの
	const best = new Map<string, WatchMove>();
	const offer = (m: WatchMove) => {
		const key = `${m.buyId}:${m.kind}`;
		const cur = best.get(key);
		if (!cur || compare(m, cur) < 0) best.set(key, m);
	};
	const buys: WatchBuy[] = p.buys.map((b) => {
		const mine = (buyId: string | null | undefined) =>
			buyRuleOf(p, buyId).id === b.id;
		const myLots = lots.filter((l) => mine(l.buyId));
		const openBuys = openOrders.filter(
			(o) => o.side === "buy" && mine(o.buyId),
		).length;
		const buy = watchGroup(b.buy, ctx);
		const status = buyStatus(b, input, buy, {
			openBuys,
			free: b.maxPositions - myLots.length - openBuys,
			cooldownLeft,
			wasHit: hits[b.id] ?? null,
		});
		const act = (
			kind: WatchActionKind,
			g: WatchGroup | null,
			lotId: string | null,
		) => {
			if (!g) return;
			if (g.met)
				actions.push({
					kind,
					price: null,
					buyId: b.id,
					buyName: b.name,
					lotId,
				});
			for (const t of g.triggers) {
				actions.push({ kind, price: t, buyId: b.id, buyName: b.name, lotId });
			}
		};
		const move = (kind: WatchActionKind, trigger: WatchTrigger | null) => {
			if (trigger) offer({ kind, buyId: b.id, buyName: b.name, trigger });
		};
		// 買えない間（約定待ち・最大ロット数・損切り後の待ちなど）は買いを次の動きに出さない
		if (status.kind === "ready") {
			act("entry", buy, null);
			move("entry", groupTrigger(buy, ctx));
		}

		const watchLots: WatchLot[] = myLots.map((lot) => {
			const partialDone = lot.partialExitDone ?? false;
			if (selling.has(lot.id)) {
				return {
					id: lot.id,
					entryPrice: lot.entryPrice,
					quantity: lot.quantity,
					selling: true,
					groups: null,
					breakeven: null,
					partialDone,
				};
			}
			const lotCtx: Ctx = {
				...ctx,
				lot: {
					entryPrice: lot.entryPrice,
					openedAt: lot.openedAt,
					peak: peaks?.[lot.id] ?? lot.entryPrice,
					atrs: entryAtrs?.[lot.id] ?? {},
				},
			};
			const partialQty = partialDone
				? 0
				: partialSellQuantity(lot.quantity, b.partialSell.percent);
			const groups = {
				stopLoss: watchGroup(b.stopLoss, lotCtx),
				takeProfit: watchGroup(b.takeProfit, lotCtx),
				partialTakeProfit:
					b.partialTakeProfit.conditions.length > 0 &&
					partialQty > 0 &&
					partialQty < lot.quantity
						? watchGroup(b.partialTakeProfit, lotCtx)
						: null,
			};
			const breakeven =
				partialDone && b.partialSell.breakevenStop ? lot.entryPrice : null;
			act("stopLoss", groups.stopLoss, lot.id);
			// 損切りの条件が成立済みなら、建値ストップと合わせても売りは1回なので重ねない
			if (breakeven !== null && groups.stopLoss.met !== true) {
				actions.push({
					kind: "stopLoss",
					price: price < breakeven ? null : breakeven,
					buyId: b.id,
					buyName: b.name,
					lotId: lot.id,
				});
			}
			act("takeProfit", groups.takeProfit, lot.id);
			act("partialTakeProfit", groups.partialTakeProfit, lot.id);
			move("stopLoss", groupTrigger(groups.stopLoss, lotCtx));
			if (breakeven !== null) {
				move(
					"stopLoss",
					price < breakeven
						? { kind: "now" }
						: { kind: "price", price: breakeven },
				);
			}
			move("takeProfit", groupTrigger(groups.takeProfit, lotCtx));
			if (groups.partialTakeProfit) {
				move(
					"partialTakeProfit",
					groupTrigger(groups.partialTakeProfit, lotCtx),
				);
			}
			return {
				id: lot.id,
				entryPrice: lot.entryPrice,
				quantity: lot.quantity,
				selling: false,
				groups,
				breakeven,
				partialDone,
			};
		});
		return {
			id: b.id,
			name: b.name,
			maxPositions: b.maxPositions,
			holding: myLots.length,
			status,
			buy,
			lots: watchLots,
		};
	});
	for (const o of openOrders) {
		const buyId =
			o.side === "buy" ? o.buyId : lots.find((l) => l.id === o.lotId)?.buyId;
		const b = buyRuleOf(p, buyId);
		offer({
			kind: o.side === "buy" ? "entry" : "sell",
			buyId: b.id,
			buyName: b.name,
			trigger: { kind: "order", price: o.price },
		});
	}
	return { price, buys, actions, moves: [...best.values()].sort(compare) };
}
