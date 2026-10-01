// 画面で作る「条件のセット」を実行する汎用の条件戦略

import { formatBtc, formatYen } from "./format";
import { bollinger, ema, rsi } from "./indicators";
import { limitBuyPriceBelow, notionalYen, SATOSHI_PER_BTC } from "./money";
import type {
	Judge,
	JudgmentConditionValue,
	JudgmentValue,
} from "./news-judgment";
import {
	JUDGE_LABELS,
	JUDGES,
	JUDGMENT_CONDITION_VALUES,
	JUDGMENT_VALUE_LABELS,
	JUDGMENT_VALUES,
	NO_JUDGMENT,
} from "./news-judgment";
import type {
	Strategy,
	StrategyInput,
	StrategyOutput,
	ValidationError,
} from "./strategy";
import type { Timeframe } from "./timeframe";
import {
	isCoarser,
	isTimeframe,
	TIMEFRAME_LABELS,
	TIMEFRAME_MS,
	TIMEFRAMES,
} from "./timeframe";
import type { Candle, JsonValue, OrderIntent, OrderType } from "./types";

export const FREQUENCY_UNITS = ["s", "m", "h"] as const;
export type FrequencyUnit = (typeof FREQUENCY_UNITS)[number];

export const FREQUENCY_UNIT_LABELS: Record<FrequencyUnit, string> = {
	s: "秒",
	m: "分",
	h: "時間",
};

const FREQUENCY_UNIT_MS: Record<FrequencyUnit, number> = {
	s: 1000,
	m: 60_000,
	h: 3_600_000,
};

/** 判定頻度。整数＋単位 */
export type Frequency = { value: number; unit: FrequencyUnit };

export type Condition =
	/** 短期 EMA が長期 EMA を上抜け（up）/ 下抜け（down）した */
	| {
			type: "emaCross";
			timeframe: Timeframe;
			fast: number;
			slow: number;
			direction: "up" | "down";
	  }
	/** 終値が直近 N 本の最高値を上抜けた（high）/ 最安値を下抜けた（low） */
	| {
			type: "breakout";
			timeframe: Timeframe;
			lookback: number;
			direction: "high" | "low";
	  }
	/** RSI(period) が threshold 以上（above）/ 以下（below）。どのグループでも使える */
	| {
			type: "rsi";
			timeframe: Timeframe;
			period: number;
			threshold: number;
			direction: "above" | "below";
	  }
	/** 直近 bars 本以内に RSI(period) が threshold を上抜け（up）/ 下抜け（down）した。どのグループでも使える */
	| {
			type: "rsiCross";
			timeframe: Timeframe;
			period: number;
			threshold: number;
			bars: number;
			direction: "up" | "down";
	  }
	/** 終値が EMA(period) より上（above）/ 下（below）。どのグループでも使える */
	| {
			type: "emaPosition";
			timeframe: Timeframe;
			period: number;
			direction: "above" | "below";
	  }
	/** EMA(period) が bars 本前から percent % 以上 上がった（up）/ 下がった（down）。percent が 0 なら向きだけを見る。どのグループでも使える */
	| {
			type: "emaSlope";
			timeframe: Timeframe;
			period: number;
			bars: number;
			percent: number;
			direction: "up" | "down";
	  }
	/** 終値がボリンジャーバンド（period 本・sigma σ）の上限以上（upper）/ 下限以下（lower）。どのグループでも使える */
	| {
			type: "bollinger";
			timeframe: Timeframe;
			period: number;
			sigma: number;
			band: "upper" | "lower";
	  }
	/** 現在値が買値から percent % 上がった（up）/ 下がった（down）。売りのグループだけで使える */
	| { type: "entryChange"; percent: number; direction: "up" | "down" }
	/**
	 * 現在値が買ってからの最高値から percent % 下がった。最高値が買値から activatePercent % 以上になるまでは成立しない（0 は買った直後から）。
	 * 売りのグループだけで使える
	 */
	| { type: "trailingStop"; percent: number; activatePercent: number }
	/** 買ってから timeframe の足で bars 本ぶんの時間が経った。売りのグループだけで使える */
	| { type: "holdingBars"; timeframe: Timeframe; bars: number }
	/** AI の判定が values のどれか。判定がまだ無いときは values に NO_JUDGMENT があれば成立。どのグループでも使える */
	| { type: "judgment"; judge: Judge; values: JudgmentConditionValue[] };

export type ConditionType = Condition["type"];

/** 足を持つ条件 */
export type TimeframeCondition = Extract<Condition, { timeframe: Timeframe }>;

/** 足を指定して見る条件の種類 */
export const TIMEFRAME_CONDITION_TYPES = [
	"emaCross",
	"breakout",
	"rsi",
	"rsiCross",
	"emaPosition",
	"emaSlope",
	"bollinger",
	"holdingBars",
] as const satisfies readonly TimeframeCondition["type"][];

export function hasTimeframe(c: Condition): c is TimeframeCondition {
	return (TIMEFRAME_CONDITION_TYPES as readonly string[]).includes(c.type);
}

/** 足のデータで指標を計算する条件 */
export type CandleCondition = Exclude<
	TimeframeCondition,
	{ type: "holdingBars" }
>;

/** 足の値を指標で見る条件（足のデータが要る）。買ってからの本数は時間で数えるので足のデータは要らない */
export function needsCandles(c: Condition): c is CandleCondition {
	return hasTimeframe(c) && c.type !== "holdingBars";
}

/** 条件を追加するときの足の既定 */
export const DEFAULT_CONDITION_TIMEFRAME: Timeframe = "1h";

export type ConditionGroup = {
	/** all: すべて満たす / any: どれか1つ */
	match: "all" | "any";
	conditions: Condition[];
};

export const CONDITION_GROUPS = [
	"buy",
	"partialTakeProfit",
	"takeProfit",
	"stopLoss",
] as const;
export type ConditionGroupKey = (typeof CONDITION_GROUPS)[number];

/** 売りのグループ */
export type SellGroupKey = Exclude<ConditionGroupKey, "buy">;

export const CONDITION_GROUP_LABELS: Record<ConditionGroupKey, string> = {
	buy: "買い注文する条件",
	partialTakeProfit: "売り注文（一部利確）する条件",
	takeProfit: "売り注文（利確）する条件",
	stopLoss: "売り注文（損切り）する条件",
};

/** 一部利確の売り方。一部利確の条件が空なら使わない */
export type PartialSell = {
	/** ロットの何 % を売るか（整数） */
	percent: number;
	/** 一部利確の後、現在値が買値を下回ったら残りを損切りとして売る（建値ストップ） */
	breakevenStop: boolean;
};

/** 一部利確の売り方の既定。これを持たない保存済みの戦略もこれで読む（一部利確の条件は空なので効かない） */
export const DEFAULT_PARTIAL_SELL: PartialSell = {
	percent: 50,
	breakevenStop: true,
};

/** 買い注文の1行。成行か、現在値から何 % 下の指値か */
export type BuyOrderLine =
	| { type: "market" }
	| {
			type: "limit";
			/** 指値を現在値から何 % 下に出すか */
			belowPercent: number;
	  };

/** 買い注文の出し方。1回の条件成立で行の数だけ同時に出す。売りは常に成行 */
export type BuyOrder = {
	/** 成行は先頭の1行だけ。指値は下の行ほど大きい % */
	lines: BuyOrderLine[];
	/** 指値を expireTimeframe の足でこの本数ぶんの時間のあいだ約定しなければ取り消す。成行には効かない */
	expireBars: number;
	expireTimeframe: Timeframe;
};

export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
	limit: "指値",
	market: "成行",
};

/** 指値を現在値から下げる % の既定 */
export const DEFAULT_BUY_BELOW_PERCENT = 0.1;

/** 買い注文の出し方の既定。これを持たない保存済みの戦略もこの出し方で読む */
export const DEFAULT_BUY_ORDER: BuyOrder = {
	lines: [{ type: "limit", belowPercent: DEFAULT_BUY_BELOW_PERCENT }],
	expireBars: 3,
	expireTimeframe: DEFAULT_CONDITION_TIMEFRAME,
};

/** 成行1件で買う出し方 */
export const MARKET_BUY_ORDER: BuyOrder = {
	lines: [{ type: "market" }],
	expireBars: DEFAULT_BUY_ORDER.expireBars,
	expireTimeframe: DEFAULT_BUY_ORDER.expireTimeframe,
};

/** 最大ロット数の既定。これを持たない保存済みの戦略もこの数で読む */
export const DEFAULT_MAX_POSITIONS = 1;

/**
 * 買い1つ。買いの条件と注文の出し方に加え、この買いで買ったロットの売り方（一部利確・利確・損切り）を持つ。
 * 条件のグループのキーは CONDITION_GROUPS
 */
export type BuyRule = {
	/** ロットと注文がどの買いのものかを指す。戦略の中で重ならない */
	id: string;
	/** 画面と判断の理由に出す名前。戦略の中で重ならない */
	name: string;
	/** 1回の注文量（satoshi）。1ロットの量 */
	orderSize: number;
	/** この買いで同時に持てるロットの数（この買いの未約定の買い注文を含む） */
	maxPositions: number;
	buy: ConditionGroup;
	buyOrder: BuyOrder;
	/** 空なら一部利確しない */
	partialTakeProfit: ConditionGroup;
	partialSell: PartialSell;
	takeProfit: ConditionGroup;
	stopLoss: ConditionGroup;
};

export type ConditionSet = {
	frequency: {
		/** 保有なしのとき */
		flat: Frequency;
		/** 保有中のとき */
		holding: Frequency;
	};
	/** 1日の損失上限（円）。その日の確定損失がこれに達したら新しい買いを止める */
	dailyLossLimit: number;
	/** 損切り（建値ストップを含む）の売りを出してから、stopLossCooldownTimeframe の足でこの本数ぶんの時間は買わない（どの買いも）。0 は止めない */
	stopLossCooldownBars: number;
	stopLossCooldownTimeframe: Timeframe;
	/** 買い。同じ判定で複数の買いが成立したら、買えるもののうち上の1つだけ注文する */
	buys: BuyRule[];
};

/** 買いが1つの条件セットを、買いを持たない平らな形で書いたもの。買いを持つ前の保存済みの戦略とテストで使う */
export type SingleBuyConditionSet = Omit<ConditionSet, "buys"> &
	Omit<BuyRule, "id" | "name">;

/** 新しい買いの名前の既定（「買い1」…） */
export const buyRuleName = (n: number) => `買い${n}`;

/** 平らな形（SingleBuyConditionSet）を、買い1つの条件セットにする */
export function singleBuy(p: SingleBuyConditionSet): ConditionSet {
	const {
		frequency,
		dailyLossLimit,
		stopLossCooldownBars,
		stopLossCooldownTimeframe,
		...rule
	} = p;
	return {
		frequency,
		dailyLossLimit,
		stopLossCooldownBars,
		stopLossCooldownTimeframe,
		buys: [{ id: "b1", name: buyRuleName(1), ...rule }],
	};
}

/** 戦略の中で使っていない買いの id */
export function newBuyRuleId(p: Pick<ConditionSet, "buys">): string {
	const used = new Set(p.buys.map((b) => b.id));
	let n = p.buys.length + 1;
	while (used.has(`b${n}`)) n++;
	return `b${n}`;
}

/** ロットや注文が属する買い。買いを持たない（買いを複数持つ前の）ものと、見つからないものは先頭の買い */
export function buyRuleOf(
	p: Pick<ConditionSet, "buys">,
	buyId: string | null | undefined,
): BuyRule {
	return (p.buys.find((b) => b.id === buyId) ?? p.buys[0]) as BuyRule;
}

/** 全ての買いの、全ての条件のグループ */
function allGroups(p: ConditionSet): ConditionGroup[] {
	return p.buys.flatMap((b) => CONDITION_GROUPS.map((k) => b[k]));
}

export const LIMITS = {
	emaPeriod: { min: 2, max: 500 },
	lookback: { min: 2, max: 1000 },
	rsiPeriod: { min: 2, max: 100 },
	rsiThreshold: { min: 1, max: 99 },
	/** RSI のクロスを何本以内で見るか */
	rsiCrossBars: { min: 1, max: 100 },
	bollingerPeriod: { min: 2, max: 500 },
	/** ボリンジャーバンドの σ。0.1 刻み */
	bollingerSigma: { min: 0.1, max: 5 },
	percent: { min: 0.1, max: 100 },
	/** トレーリングストップを発動する、最高値の買値からの %。0 は買った直後から */
	trailingActivatePercent: { min: 0, max: 100 },
	/** 一部利確で売る割合（%、整数） */
	partialSellPercent: { min: 1, max: 99 },
	/** EMA の傾きで何本前と比べるか */
	emaSlopeBars: { min: 1, max: 500 },
	/** EMA の傾きの %。0.01 刻み */
	emaSlopePercent: { min: 0, max: 100 },
	holdingBars: { min: 1, max: 1000 },
	/** 買い指値を現在値から下げる %。0 以上 100 未満、0.01 刻み */
	buyBelowPercent: { min: 0, maxExclusive: 100 },
	buyExpireBars: { min: 1, max: 100 },
	/** 買い注文の行の数 */
	buyOrderLines: { min: 1, max: 10 },
	maxPositions: { min: 1, max: 10 },
	frequency: { min: 1, max: 999 },
	/** 注文量（satoshi）。0.001〜1 BTC */
	orderSize: { min: 100_000, max: SATOSHI_PER_BTC },
	/** 1日の損失上限（円） */
	dailyLossLimit: { min: 1, max: 100_000_000 },
	/** 損切り後に買わない本数。0 は止めない */
	stopLossCooldownBars: { min: 0, max: 1000 },
	/** 買いの数 */
	buys: { min: 1, max: 5 },
	/** 買いの名前の文字数 */
	buyName: { min: 1, max: 20 },
} as const;

/** 1日の損失上限の既定（仮置き）。これを持たない保存済みの戦略もこの上限で読む */
export const DEFAULT_DAILY_LOSS_LIMIT = 30_000;

/** 損切り後に買わない本数の既定。これを持たない保存済みの戦略もこの本数（止めない）で読む */
export const DEFAULT_STOP_LOSS_COOLDOWN_BARS = 0;

/** EMA・RSI を途中から計算しても値がほぼ一致するよう、本数のこの倍の足を渡してもらう */
const EMA_HISTORY_FACTOR = 10;

type Hit = { ok: true; why: string } | { ok: false } | { insufficient: string };

/** 1つの粒度の足と、その足で計算した指標 */
type Series = {
	candles: readonly Candle[];
	closes: number[];
	emaCache: Map<number, number[]>;
	rsiCache: Map<number, number[]>;
	bollingerCache: Map<string, ReturnType<typeof bollinger>>;
};

type Ctx = {
	/** 粒度ごとの足。渡されていない粒度は足が0本 */
	series: (timeframe: Timeframe) => Series;
	/** 判定器ごとの今の判定。まだ無ければ入らない */
	judgments: Partial<Record<Judge, JudgmentValue>>;
	price: number;
	now: number;
	/** 売りの判定中のロット。買いの判定では null */
	lot: {
		entryPrice: number;
		openedAt: number;
		peak: number;
	} | null;
};

function seriesOf(candles: readonly Candle[]): Series {
	return {
		candles,
		closes: candles.map((c) => c.close),
		emaCache: new Map(),
		rsiCache: new Map(),
		bollingerCache: new Map(),
	};
}

function emaOf(ctx: Series, period: number): number[] {
	let v = ctx.emaCache.get(period);
	if (!v) {
		v = ema(ctx.closes, period);
		ctx.emaCache.set(period, v);
	}
	return v;
}

function rsiOf(ctx: Series, period: number): number[] {
	let v = ctx.rsiCache.get(period);
	if (!v) {
		v = rsi(ctx.closes, period);
		ctx.rsiCache.set(period, v);
	}
	return v;
}

/** RSI の見せ方。小数1桁 */
export const formatRsi = (v: number) => v.toFixed(1);

/** 条件を判定できる最少の足の数（途中の足を含む）。これより少なければ判定しない */
export function minBars(c: CandleCondition): number {
	switch (c.type) {
		case "emaCross":
			return c.slow + 1;
		case "breakout":
			return c.lookback + 1;
		case "rsi":
			return c.period + 1;
		// 最も古い足でのクロスに、その前の足の RSI が要る
		case "rsiCross":
			return c.period + c.bars + 1;
		case "emaSlope":
			return c.period + c.bars;
		case "emaPosition":
		case "bollinger":
			return c.period;
	}
}

/**
 * 期間の頭で、足ごとに判定に足りない本数。firstTimes は足ごとの最初の足の時刻（無ければ null）。
 * 期間より前の確定した足と期間の頭の途中の足で数え、欠損は数えない。足りる足は返さない
 */
export function historyShortfalls(
	params: ConditionSet,
	from: number,
	firstTimes: Partial<Record<Timeframe, number | null>>,
): { timeframe: Timeframe; missing: number }[] {
	const need: Partial<Record<Timeframe, number>> = {};
	for (const g of allGroups(params)) {
		for (const c of g.conditions) {
			if (!needsCandles(c)) continue;
			need[c.timeframe] = Math.max(need[c.timeframe] ?? 0, minBars(c));
		}
	}
	const out: { timeframe: Timeframe; missing: number }[] = [];
	for (const tf of TIMEFRAMES) {
		const n = need[tf];
		if (n === undefined) continue;
		const first = firstTimes[tf] ?? null;
		const before =
			first === null || first >= from
				? 0
				: Math.floor((from - first) / TIMEFRAME_MS[tf]);
		const missing = n - 1 - before;
		if (missing > 0) out.push({ timeframe: tf, missing });
	}
	return out;
}

function checkCondition(c: Condition, ctx: Ctx): Hit {
	if (!needsCandles(c)) return checkOther(c, ctx);
	const sr = ctx.series(c.timeframe);
	const n = sr.candles.length;
	// 条件の文の頭に付ける足の名前（例: 日足の）
	const tf = `${TIMEFRAME_LABELS[c.timeframe]}の`;
	switch (c.type) {
		case "emaCross": {
			const need = minBars(c);
			if (n < need) {
				return {
					insufficient: `${tf}EMA(${c.slow}) に ${need} 本必要、現在 ${n} 本`,
				};
			}
			const f = emaOf(sr, c.fast);
			const s = emaOf(sr, c.slow);
			const f0 = f[n - 2] as number;
			const s0 = s[n - 2] as number;
			const f1 = f[n - 1] as number;
			const s1 = s[n - 1] as number;
			// 等しい場合はクロスとみなさない
			const hit =
				c.direction === "up" ? f0 < s0 && f1 > s1 : f0 > s0 && f1 < s1;
			return hit
				? {
						ok: true,
						why: `${tf}短期EMA(${c.fast}) ${formatYen(f1)} が長期EMA(${c.slow}) ${formatYen(s1)} を${c.direction === "up" ? "上抜け" : "下抜け"}`,
					}
				: { ok: false };
		}
		case "breakout": {
			const need = minBars(c);
			if (n < need) {
				return {
					insufficient: `${tf}直近 ${c.lookback} 本に ${need} 本必要、現在 ${n} 本`,
				};
			}
			// 現在の足を除く直近 N 本
			const window = sr.candles.slice(n - 1 - c.lookback, n - 1);
			if (c.direction === "high") {
				const high = Math.max(...window.map((x) => x.high));
				return ctx.price > high
					? {
							ok: true,
							why: `終値 ${formatYen(ctx.price)} が${tf}直近 ${c.lookback} 本の最高値 ${formatYen(high)} を上抜け`,
						}
					: { ok: false };
			}
			const low = Math.min(...window.map((x) => x.low));
			return ctx.price < low
				? {
						ok: true,
						why: `終値 ${formatYen(ctx.price)} が${tf}直近 ${c.lookback} 本の最安値 ${formatYen(low)} を下抜け`,
					}
				: { ok: false };
		}
		case "rsi": {
			const need = minBars(c);
			if (n < need) {
				return {
					insufficient: `${tf}RSI(${c.period}) に ${need} 本必要、現在 ${n} 本`,
				};
			}
			const v = rsiOf(sr, c.period)[n - 1] as number;
			const hit = c.direction === "above" ? v >= c.threshold : v <= c.threshold;
			return hit
				? {
						ok: true,
						why: `${tf}RSI(${c.period}) ${formatRsi(v)} が ${c.threshold} ${c.direction === "above" ? "以上" : "以下"}`,
					}
				: { ok: false };
		}
		case "rsiCross": {
			// 最も古い足でのクロスに、その前の足の RSI が要る
			const need = minBars(c);
			if (n < need) {
				return {
					insufficient: `${tf}RSI(${c.period}) のクロスに ${need} 本必要、現在 ${n} 本`,
				};
			}
			const r = rsiOf(sr, c.period);
			const up = c.direction === "up";
			for (let k = 0; k < c.bars; k++) {
				const prev = r[n - 2 - k] as number;
				const cur = r[n - 1 - k] as number;
				const crossed = up
					? prev < c.threshold && cur >= c.threshold
					: prev > c.threshold && cur <= c.threshold;
				if (!crossed) continue;
				const now = r[n - 1] as number;
				const verb = up ? "上抜け" : "下抜け";
				return {
					ok: true,
					why:
						k === 0
							? `${tf}RSI(${c.period}) が ${c.threshold} を${verb}（前の足 ${formatRsi(prev)} → 今 ${formatRsi(cur)}）`
							: `${tf}RSI(${c.period}) が ${k} 本前に ${c.threshold} を${verb}（今 ${formatRsi(now)}）`,
				};
			}
			return { ok: false };
		}
		case "emaPosition": {
			if (n < c.period) {
				return {
					insufficient: `${tf}EMA(${c.period}) に ${c.period} 本必要、現在 ${n} 本`,
				};
			}
			const v = emaOf(sr, c.period)[n - 1] as number;
			const hit = c.direction === "above" ? ctx.price > v : ctx.price < v;
			return hit
				? {
						ok: true,
						why: `終値 ${formatYen(ctx.price)} が${tf}EMA(${c.period}) ${formatYen(v)} より${c.direction === "above" ? "上" : "下"}`,
					}
				: { ok: false };
		}
		case "emaSlope": {
			const need = minBars(c);
			if (n < need) {
				return {
					insufficient: `${tf}EMA(${c.period}) の ${c.bars} 本前比に ${need} 本必要、現在 ${n} 本`,
				};
			}
			const e = emaOf(sr, c.period);
			const before = e[n - 1 - c.bars] as number;
			const now = e[n - 1] as number;
			const change = (now / before - 1) * 100;
			// 変化が 0 のときはどちらの向きでも成立しない
			const hit =
				c.direction === "up"
					? change > 0 && change >= c.percent
					: change < 0 && -change >= c.percent;
			const sign = change >= 0 ? "+" : "−";
			const target =
				c.percent > 0
					? `（${c.direction === "up" ? "+" : "−"}${c.percent}% 以上）`
					: "";
			return hit
				? {
						ok: true,
						why: `${tf}EMA(${c.period}) ${formatYen(now)} は ${c.bars} 本前 ${formatYen(before)} から ${sign}${Math.abs(change).toFixed(2)}%${target}`,
					}
				: { ok: false };
		}
		case "bollinger": {
			if (n < c.period) {
				return {
					insufficient: `${tf}ボリンジャーバンド(${c.period}) に ${c.period} 本必要、現在 ${n} 本`,
				};
			}
			const key = `${c.period}:${c.sigma}`;
			let b = sr.bollingerCache.get(key);
			if (!b) {
				b = bollinger(sr.closes, c.period, c.sigma);
				sr.bollingerCache.set(key, b);
			}
			const name = `${tf}ボリンジャーバンド(${c.period}本・${c.sigma}σ)`;
			if (c.band === "upper") {
				const v = b.upper[n - 1] as number;
				return ctx.price >= v
					? {
							ok: true,
							why: `終値 ${formatYen(ctx.price)} が${name}の上限 ${formatYen(v)} 以上`,
						}
					: { ok: false };
			}
			const v = b.lower[n - 1] as number;
			return ctx.price <= v
				? {
						ok: true,
						why: `終値 ${formatYen(ctx.price)} が${name}の下限 ${formatYen(v)} 以下`,
					}
				: { ok: false };
		}
	}
}

/** 足に依らない条件と、買ってからの本数 */
function checkOther(c: Exclude<Condition, CandleCondition>, ctx: Ctx): Hit {
	switch (c.type) {
		case "judgment": {
			const v = ctx.judgments[c.judge];
			const name = JUDGE_LABELS[c.judge];
			const label = (x: string) => JUDGMENT_VALUE_LABELS[x] ?? x;
			const current = v ?? NO_JUDGMENT;
			return (c.values as string[]).includes(current)
				? {
						ok: true,
						why: `${name}が${label(current)}（${c.values.map(label).join("・")}のどれか）`,
					}
				: { ok: false };
		}
		case "entryChange": {
			if (ctx.lot === null) {
				return { ok: false };
			}
			const { entryPrice } = ctx.lot;
			const change = (ctx.price / entryPrice - 1) * 100;
			const hit =
				c.direction === "up" ? change >= c.percent : -change >= c.percent;
			const sign = change >= 0 ? "+" : "−";
			return hit
				? {
						ok: true,
						why: `現在値 ${formatYen(ctx.price)} は買値 ${formatYen(entryPrice)} から ${sign}${Math.abs(change).toFixed(1)}%（${c.direction === "up" ? "+" : "−"}${c.percent}% 以上）`,
					}
				: { ok: false };
		}
		case "trailingStop": {
			if (ctx.lot === null) {
				return { ok: false };
			}
			const { peak, entryPrice } = ctx.lot;
			// 最高値が買値から activatePercent % 以上になるまでは発動しない
			if (
				c.activatePercent > 0 &&
				(peak / entryPrice - 1) * 100 < c.activatePercent
			) {
				return { ok: false };
			}
			const drop = (1 - ctx.price / peak) * 100;
			const since =
				c.activatePercent > 0
					? `。最高値が買値から +${c.activatePercent}% 以上になってから発動`
					: "";
			// 発動の文は別の文にする（売りのバッジが「（−N% 以上）」で終わる文から条件名を読むため）
			return drop >= c.percent
				? {
						ok: true,
						why: `現在値 ${formatYen(ctx.price)} は買ってからの最高値 ${formatYen(peak)} から −${drop.toFixed(1)}%（−${c.percent}% 以上）${since}`,
					}
				: { ok: false };
		}
		case "holdingBars": {
			if (ctx.lot === null) {
				return { ok: false };
			}
			const bars = Math.floor(
				(ctx.now - ctx.lot.openedAt) / TIMEFRAME_MS[c.timeframe],
			);
			const tf = TIMEFRAME_LABELS[c.timeframe];
			return bars >= c.bars
				? {
						ok: true,
						why: `買ってから${tf}で ${bars} 本経過（${c.bars} 本以上）`,
					}
				: { ok: false };
		}
	}
}

type GroupResult =
	| { kind: "hit"; why: string }
	| { kind: "miss" }
	| { kind: "insufficient"; why: string };

function evaluateGroup(g: ConditionGroup, ctx: Ctx): GroupResult {
	if (g.conditions.length === 0) {
		return { kind: "miss" };
	}
	const hits = g.conditions.map((c) => checkCondition(c, ctx));
	const lacking = hits.find(
		(h): h is { insufficient: string } => "insufficient" in h,
	);
	if (lacking) {
		return { kind: "insufficient", why: lacking.insufficient };
	}
	const ok = hits.filter(
		(h): h is { ok: true; why: string } => "ok" in h && h.ok,
	);
	const satisfied =
		g.match === "all" ? ok.length === hits.length : ok.length > 0;
	return satisfied
		? { kind: "hit", why: `${ok.map((h) => h.why).join("。")}。` }
		: { kind: "miss" };
}

export function frequencyMs(f: Frequency): number {
	return f.value * FREQUENCY_UNIT_MS[f.unit];
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** 条件が足のデータを使う粒度（細かい順、重複なし） */
export function candleTimeframes(params: ConditionSet): Timeframe[] {
	const used = new Set<Timeframe>();
	for (const g of allGroups(params)) {
		for (const c of g.conditions) {
			if (needsCandles(c)) used.add(c.timeframe);
		}
	}
	return TIMEFRAMES.filter((t) => used.has(t));
}

/**
 * 判定頻度どおりに判定するのに要る足の粒度。両方の判定頻度を割り切れる粒度のうち最も粗いもの。
 * 条件が使う足の途中の足をこの足から組み立てるため、条件が使う最も細かい足が上限。
 * 1分の倍数でない頻度（秒単位）はどの粒度でも割り切れないので null
 */
export function idealStepTimeframe(params: ConditionSet): Timeframe | null {
	const g = gcd(
		frequencyMs(params.frequency.flat),
		frequencyMs(params.frequency.holding),
	);
	// 指値の取消も進める足の単位でしか見られないので、取消を数える足より粗くしない
	const caps = candleTimeframes(params).map((t) => TIMEFRAME_MS[t]);
	for (const b of params.buys) {
		if (b.buyOrder.lines.some((l) => l.type === "limit"))
			caps.push(TIMEFRAME_MS[b.buyOrder.expireTimeframe]);
	}
	const cap = Math.min(TIMEFRAME_MS["1d"], ...caps);
	const fits = TIMEFRAMES.filter(
		(t) => TIMEFRAME_MS[t] <= cap && g % TIMEFRAME_MS[t] === 0,
	);
	return fits.at(-1) ?? null;
}

/**
 * バックテストで判定に使う足の粒度。取り込み済みの最も細かいデータ（finest）までしか細かくできない。
 * limited は、データが足りず判定頻度より粗い間隔でしか判定できないこと
 */
export function chooseStepTimeframe(
	params: ConditionSet,
	finest: Timeframe,
): { timeframe: Timeframe; limited: boolean } {
	const ideal = idealStepTimeframe(params);
	if (ideal !== null && !isCoarser(finest, ideal)) {
		return { timeframe: ideal, limited: false };
	}
	return { timeframe: finest, limited: true };
}

/** 戦略が使う EMA の本数（小さい順、重複なし。足の粒度は問わない）。チャートの EMA 線に使う */
export function emaPeriods(params: ConditionSet): number[] {
	const set = new Set<number>();
	for (const g of allGroups(params)) {
		for (const c of g.conditions) {
			if (c.type === "emaCross") {
				set.add(c.fast);
				set.add(c.slow);
			} else if (c.type === "emaPosition" || c.type === "emaSlope") {
				set.add(c.period);
			}
		}
	}
	return [...set].sort((a, b) => a - b);
}

/** 戦略が使う RSI の本数ごとの、条件のしきい値（本数・しきい値とも小さい順、重複なし。足の粒度は問わない）。チャートの RSI に使う */
export function rsiLines(
	params: ConditionSet,
): { period: number; thresholds: number[] }[] {
	const map = new Map<number, Set<number>>();
	for (const g of allGroups(params)) {
		for (const c of g.conditions) {
			if (c.type === "rsi" || c.type === "rsiCross") {
				const set = map.get(c.period) ?? new Set<number>();
				set.add(c.threshold);
				map.set(c.period, set);
			}
		}
	}
	return [...map]
		.sort(([a], [b]) => a - b)
		.map(([period, set]) => ({
			period,
			thresholds: [...set].sort((a, b) => a - b),
		}));
}

/** 戦略が使う判定器（JUDGES の並び、重複なし） */
export function requiredJudges(params: ConditionSet): Judge[] {
	const used = new Set<Judge>();
	for (const g of allGroups(params)) {
		for (const c of g.conditions) {
			if (c.type === "judgment") used.add(c.judge);
		}
	}
	return JUDGES.filter((j) => used.has(j));
}

/** 判定の条件のどれかで「データなし」を選んでいるか。採点の記録が始まる前を含む期間のバックテストはこれが true のときだけ実行する */
export function acceptsNoJudgment(params: ConditionSet): boolean {
	return allGroups(params).some((g) =>
		g.conditions.some(
			(c) =>
				c.type === "judgment" && (c.values as string[]).includes(NO_JUDGMENT),
		),
	);
}

/** 判定に渡してほしい足の本数（現在の足を含む）を粒度ごとに */
export function candleNeeds(
	params: ConditionSet,
): Partial<Record<Timeframe, number>> {
	const out: Partial<Record<Timeframe, number>> = {};
	for (const g of allGroups(params)) {
		for (const c of g.conditions) {
			if (!needsCandles(c)) continue;
			const n =
				c.type === "emaCross"
					? c.slow * EMA_HISTORY_FACTOR + 1
					: c.type === "emaPosition" || c.type === "rsi"
						? c.period * EMA_HISTORY_FACTOR + 1
						: c.type === "emaSlope" || c.type === "rsiCross"
							? c.period * EMA_HISTORY_FACTOR + c.bars + 1
							: c.type === "breakout"
								? c.lookback + 1
								: c.period;
			out[c.timeframe] = Math.max(out[c.timeframe] ?? 1, n);
		}
	}
	return out;
}

/**
 * 判定に渡してほしい直近の細かい足の時間の長さ。トレーリングストップの最高値を、前回の判定から今回までの値動きで取りこぼさないため。
 * 使わなければ 0
 */
export function recentMs(params: ConditionSet): number {
	return usesCondition(params, "trailingStop")
		? frequencyMs(params.frequency.holding)
		: 0;
}

function isIntIn(v: unknown, r: { min: number; max: number }): v is number {
	return (
		Number.isInteger(v) && (v as number) >= r.min && (v as number) <= r.max
	);
}

function isNumIn(v: unknown, r: { min: number; max: number }): v is number {
	return (
		typeof v === "number" && Number.isFinite(v) && v >= r.min && v <= r.max
	);
}

/** 条件セットの入力検証。path は「buys.0.buy.conditions.0.fast」のようにフォームの項目を指す */
export function validateConditionSet(p: ConditionSet): ValidationError[] {
	const errors: ValidationError[] = [];
	const err = (path: string, message: string) => errors.push({ path, message });

	if (!isIntIn(p.stopLossCooldownBars, LIMITS.stopLossCooldownBars)) {
		const r = LIMITS.stopLossCooldownBars;
		err("stopLossCooldownBars", `${r.min}〜${r.max} の整数で入れる`);
	}
	if (!isTimeframe(p.stopLossCooldownTimeframe)) {
		err("stopLossCooldownTimeframe", "足を選ぶ");
	}
	if (!isIntIn(p.dailyLossLimit, LIMITS.dailyLossLimit)) {
		err(
			"dailyLossLimit",
			`${formatYen(LIMITS.dailyLossLimit.min)}〜${formatYen(LIMITS.dailyLossLimit.max)} 円の整数で入れる`,
		);
	}
	for (const k of ["flat", "holding"] as const) {
		const f = p.frequency[k];
		if (!isIntIn(f.value, LIMITS.frequency)) {
			err(
				`frequency.${k}`,
				`${LIMITS.frequency.min}〜${LIMITS.frequency.max} の整数で入れる`,
			);
		}
		if (!FREQUENCY_UNITS.includes(f.unit)) {
			err(`frequency.${k}`, "単位を選ぶ");
		}
	}
	const n = LIMITS.buys;
	if (p.buys.length < n.min || p.buys.length > n.max) {
		err("buys", `買いは ${n.min}〜${n.max} 個にする`);
	}
	const ids = new Set<string>();
	const names = new Set<string>();
	p.buys.forEach((b, i) => {
		const at = `buys.${i}`;
		// id は画面が付けるので、重なりは入力の誤りでなく作りの誤り。それでも売りの判定が混ざるので保存させない
		if (typeof b.id !== "string" || b.id === "" || ids.has(b.id)) {
			err(at, "買いの id が重なっている");
		}
		ids.add(b.id);
		const name = b.name.trim();
		const r = LIMITS.buyName;
		if (name.length < r.min || name.length > r.max) {
			err(`${at}.name`, `${r.min}〜${r.max} 文字で入れる`);
		} else if (names.has(name)) {
			err(`${at}.name`, "ほかの買いと違う名前にする");
		}
		names.add(name);
		validateBuyRule(b, at, err);
	});
	return errors;
}

/** 買い1つの入力検証。prefix は「buys.0」 */
function validateBuyRule(
	p: BuyRule,
	prefix: string,
	report: (path: string, message: string) => void,
) {
	const err = (path: string, message: string) =>
		report(`${prefix}.${path}`, message);
	const size = LIMITS.orderSize;
	if (!isIntIn(p.orderSize, size)) {
		err(
			"orderSize",
			`${formatBtc(size.min)}〜${formatBtc(size.max)} BTC の範囲で入れる（最小単位 0.00000001）`,
		);
	}
	for (const g of CONDITION_GROUPS) {
		p[g].conditions.forEach((c, i) => {
			const at = `${g}.conditions.${i}`;
			const range = (r: { min: number; max: number }) => `${r.min}〜${r.max}`;
			if (hasTimeframe(c) && !isTimeframe(c.timeframe)) {
				err(`${at}.timeframe`, "足を選ぶ");
			}
			switch (c.type) {
				case "emaCross": {
					const r = LIMITS.emaPeriod;
					const fastOk = isIntIn(c.fast, r);
					const slowOk = isIntIn(c.slow, r);
					if (!fastOk) err(`${at}.fast`, `${range(r)} の整数で入れる`);
					if (!slowOk) err(`${at}.slow`, `${range(r)} の整数で入れる`);
					if (fastOk && slowOk && c.fast >= c.slow) {
						err(`${at}.fast`, `長期（${c.slow}）より小さくする`);
					}
					break;
				}
				case "breakout":
					if (!isIntIn(c.lookback, LIMITS.lookback)) {
						err(`${at}.lookback`, `${range(LIMITS.lookback)} の整数で入れる`);
					}
					break;
				case "rsi":
					if (!isIntIn(c.period, LIMITS.rsiPeriod)) {
						err(`${at}.period`, `${range(LIMITS.rsiPeriod)} の整数で入れる`);
					}
					if (!isIntIn(c.threshold, LIMITS.rsiThreshold)) {
						err(
							`${at}.threshold`,
							`${range(LIMITS.rsiThreshold)} の整数で入れる`,
						);
					}
					break;
				case "rsiCross":
					if (!isIntIn(c.period, LIMITS.rsiPeriod)) {
						err(`${at}.period`, `${range(LIMITS.rsiPeriod)} の整数で入れる`);
					}
					if (!isIntIn(c.threshold, LIMITS.rsiThreshold)) {
						err(
							`${at}.threshold`,
							`${range(LIMITS.rsiThreshold)} の整数で入れる`,
						);
					}
					if (!isIntIn(c.bars, LIMITS.rsiCrossBars)) {
						err(`${at}.bars`, `${range(LIMITS.rsiCrossBars)} の整数で入れる`);
					}
					break;
				case "judgment": {
					const allowed = JUDGMENT_CONDITION_VALUES[c.judge] as
						| readonly string[]
						| undefined;
					if (!allowed) {
						err(`${at}.judge`, "判定器を選ぶ");
					} else if (c.values.length === 0) {
						err(`${at}.values`, "1つ以上選ぶ");
					} else if (
						c.values.some((v) => !allowed.includes(v)) ||
						new Set(c.values).size !== c.values.length
					) {
						err(`${at}.values`, "選べない値がある");
					}
					break;
				}
				case "emaPosition":
					if (!isIntIn(c.period, LIMITS.emaPeriod)) {
						err(`${at}.period`, `${range(LIMITS.emaPeriod)} の整数で入れる`);
					}
					break;
				case "emaSlope": {
					if (!isIntIn(c.period, LIMITS.emaPeriod)) {
						err(`${at}.period`, `${range(LIMITS.emaPeriod)} の整数で入れる`);
					}
					if (!isIntIn(c.bars, LIMITS.emaSlopeBars)) {
						err(`${at}.bars`, `${range(LIMITS.emaSlopeBars)} の整数で入れる`);
					}
					const r = LIMITS.emaSlopePercent;
					if (
						!isNumIn(c.percent, r) ||
						Math.abs(c.percent * 100 - Math.round(c.percent * 100)) > 1e-9
					) {
						err(`${at}.percent`, `${range(r)}、0.01 刻みで入れる`);
					}
					break;
				}
				case "bollinger": {
					if (!isIntIn(c.period, LIMITS.bollingerPeriod)) {
						err(
							`${at}.period`,
							`${range(LIMITS.bollingerPeriod)} の整数で入れる`,
						);
					}
					const r = LIMITS.bollingerSigma;
					if (
						!isNumIn(c.sigma, r) ||
						Math.abs(c.sigma * 10 - Math.round(c.sigma * 10)) > 1e-9
					) {
						err(`${at}.sigma`, `${range(r)}、0.1 刻みで入れる`);
					}
					break;
				}
				case "entryChange":
					if (g === "buy") {
						err(at, "買値からの % は売りの条件だけで使える");
					} else if (!isNumIn(c.percent, LIMITS.percent)) {
						err(`${at}.percent`, `${range(LIMITS.percent)} の範囲で入れる`);
					}
					break;
				case "trailingStop": {
					if (g === "buy") {
						err(at, "最高値からの % は売りの条件だけで使える");
						break;
					}
					if (!isNumIn(c.percent, LIMITS.percent)) {
						err(`${at}.percent`, `${range(LIMITS.percent)} の範囲で入れる`);
					}
					const r = LIMITS.trailingActivatePercent;
					if (
						!isNumIn(c.activatePercent, r) ||
						Math.abs(
							c.activatePercent * 10 - Math.round(c.activatePercent * 10),
						) > 1e-9
					) {
						err(`${at}.activatePercent`, `${range(r)}、0.1 刻みで入れる`);
					}
					break;
				}
				case "holdingBars":
					if (g === "buy") {
						err(at, "保有本数は売りの条件だけで使える");
					} else if (!isIntIn(c.bars, LIMITS.holdingBars)) {
						err(`${at}.bars`, `${range(LIMITS.holdingBars)} の整数で入れる`);
					}
					break;
			}
		});
	}
	if (p.buy.conditions.length === 0) {
		err("buy", "買い注文の条件を1つ以上追加する");
	}
	if (!isIntIn(p.maxPositions, LIMITS.maxPositions)) {
		const r = LIMITS.maxPositions;
		err("maxPositions", `${r.min}〜${r.max} の整数で入れる`);
	}
	const lines = p.buyOrder.lines;
	const nLines = LIMITS.buyOrderLines;
	if (lines.length < nLines.min || lines.length > nLines.max) {
		err("buyOrder.lines", `注文は ${nLines.min}〜${nLines.max} 件にする`);
	}
	let prevBelow: number | null = null;
	lines.forEach((line, i) => {
		const at = `buyOrder.lines.${i}`;
		if (line.type === "market") {
			if (i > 0) err(at, "成行は1件だけ、先頭に置く");
			return;
		}
		const below = line.belowPercent;
		const r = LIMITS.buyBelowPercent;
		if (
			!Number.isFinite(below) ||
			below < r.min ||
			below >= r.maxExclusive ||
			// 0.01% 刻み（ppm の整数に丸めても値が変わらない）
			Math.abs(below * 100 - Math.round(below * 100)) > 1e-9
		) {
			err(
				`${at}.belowPercent`,
				`${r.min} 以上 ${r.maxExclusive} 未満、0.01 刻みで入れる`,
			);
		} else {
			if (prevBelow !== null && below <= prevBelow) {
				err(`${at}.belowPercent`, `上の行（${prevBelow}%）より大きくする`);
			}
			prevBelow = below;
		}
	});
	if (
		lines.some((l) => l.type === "limit") &&
		!isIntIn(p.buyOrder.expireBars, LIMITS.buyExpireBars)
	) {
		const e = LIMITS.buyExpireBars;
		err("buyOrder.expireBars", `${e.min}〜${e.max} の整数で入れる`);
	}
	if (!isTimeframe(p.buyOrder.expireTimeframe)) {
		err("buyOrder.expireTimeframe", "足を選ぶ");
	}
	if (p.stopLoss.conditions.length === 0) {
		err(
			"stopLoss",
			"損切りの条件が無いと、下がり続けても売らない。1つ以上追加する",
		);
	}
	const ps = p.partialSell;
	if (!isIntIn(ps.percent, LIMITS.partialSellPercent)) {
		const r = LIMITS.partialSellPercent;
		err("partialSell.percent", `${r.min}〜${r.max} の整数で入れる`);
	} else if (
		p.partialTakeProfit.conditions.length > 0 &&
		isIntIn(p.orderSize, size)
	) {
		const sold = partialSellQuantity(p.orderSize, ps.percent);
		if (sold < size.min || p.orderSize - sold < size.min) {
			err(
				"partialSell.percent",
				`売る量 ${formatBtc(sold)} BTC と残り ${formatBtc(p.orderSize - sold)} BTC がどちらも ${formatBtc(size.min)} BTC 以上になるようにする`,
			);
		}
	}
	if (typeof ps.breakevenStop !== "boolean") {
		err("partialSell.breakevenStop", "選ぶ");
	}
}

/** 一部利確で売る量（satoshi）。1 satoshi 未満は切り捨てる */
export function partialSellQuantity(quantity: number, percent: number): number {
	return Math.floor((quantity * percent) / 100);
}

function nextEval(now: number, p: ConditionSet, holding: boolean): number {
	return now + frequencyMs(holding ? p.frequency.holding : p.frequency.flat);
}

/** 判定器ごとの最新の判定。値として読めないものは無視する */
function latestJudgments(
	all: StrategyInput<ConditionSet>["judgments"],
): Ctx["judgments"] {
	const out: Ctx["judgments"] = {};
	for (const j of JUDGES) {
		const last = all[j]?.at(-1);
		if (
			last &&
			(JUDGMENT_VALUES[j] as readonly string[]).includes(last.label)
		) {
			out[j] = last.label as JudgmentValue;
		}
	}
	return out;
}

/**
 * 買いごとの、前回の判定で買いの条件が成立していたか。まだ判定していない買いは持たない。
 * 買いを複数持つ前の state（buyHit）は先頭の買いのものとして読む
 */
function prevBuyHits(
	state: JsonValue,
	p: ConditionSet,
): Record<string, boolean> {
	if (!isObj(state)) return {};
	if (typeof state.buyHit === "boolean") {
		return { [(p.buys[0] as BuyRule).id]: state.buyHit };
	}
	const out: Record<string, boolean> = {};
	if (isObj(state.buyHits)) {
		for (const [id, v] of Object.entries(state.buyHits)) {
			if (typeof v === "boolean") out[id] = v;
		}
	}
	return out;
}

/** 最後に損切りの売りを出した判定の時刻。無ければ null */
function prevStopLossAt(state: JsonValue): number | null {
	return isObj(state) &&
		typeof state.stopLossAt === "number" &&
		Number.isFinite(state.stopLossAt)
		? state.stopLossAt
		: null;
}

function usesCondition(p: ConditionSet, type: ConditionType): boolean {
	return allGroups(p).some((g) => g.conditions.some((c) => c.type === type));
}

/**
 * ロットごとの、買ってからの最高値。前回までの最高値（state）と、渡された直近の細かい足のうち約定より後の値動きから求める。
 * state は自動取引をオンにし直すと消えるため、足だけでも求められる形にしている
 */
function lotPeaks(
	lots: StrategyInput<ConditionSet>["lots"],
	recent: StrategyInput<ConditionSet>["recent"],
	state: JsonValue,
): Record<string, number> {
	const { candles, timeframeMs } = recent;
	const saved =
		isObj(state) && isObj(state.peaks)
			? (state.peaks as Record<string, unknown>)
			: {};
	const out: Record<string, number> = {};
	for (const lot of lots) {
		const prev = saved[lot.id];
		let peak = Math.max(
			lot.entryPrice,
			typeof prev === "number" && Number.isFinite(prev) ? prev : 0,
		);
		for (const c of candles) {
			// 約定した足は約定前の高値を含みうるので終値だけ見る。バックテストの約定時刻は足の開始時刻なので、同じ時刻の足も約定した足
			if (c.time > lot.openedAt) peak = Math.max(peak, c.high);
			else if (c.time + timeframeMs > lot.openedAt)
				peak = Math.max(peak, c.close);
		}
		out[lot.id] = peak;
	}
	return out;
}

export function evaluateConditionSet(
	input: StrategyInput<ConditionSet>,
): StrategyOutput {
	const {
		now,
		price,
		candles,
		judgments,
		lots,
		cash,
		openOrders,
		params: p,
		state,
	} = input;
	const holding = lots.length > 0;
	const nextEvalAt = nextEval(now, p, holding);

	const series = new Map<Timeframe, Series>();
	const ctx: Ctx = {
		series: (tf) => {
			let v = series.get(tf);
			if (!v) {
				v = seriesOf(candles[tf] ?? []);
				series.set(tf, v);
			}
			return v;
		},
		price,
		now,
		lot: null,
		judgments: latestJudgments(judgments),
	};
	// 買いが1つなら、理由に買いの名前を出さない（買いを複数持つ前と同じ文）
	const multi = p.buys.length >= 2;
	const cooldownMs =
		p.stopLossCooldownBars * TIMEFRAME_MS[p.stopLossCooldownTimeframe];
	const intents: OrderIntent[] = [];
	const notes: string[] = [];
	const buyHits = prevBuyHits(state, p);
	const cooldown = p.stopLossCooldownBars > 0;
	let stopLossAt = cooldown ? prevStopLossAt(state) : null;
	const peaks = usesCondition(p, "trailingStop")
		? lotPeaks(lots, input.recent, state)
		: null;

	// 売り: ロットごとに、ロットを買った買いの条件で判定する。同じ判定で利確と損切りの両方が成立したら損切りを優先する（損失を小さく見積もらないため）
	if (holding) {
		const selling = new Set(
			openOrders.filter((o) => o.side === "sell").map((o) => o.lotId),
		);
		const targets = lots.filter((l) => !selling.has(l.id));
		const sells: string[] = [];
		let lacking: string | null = null;
		for (const lot of targets) {
			const rule = buyRuleOf(p, lot.buyId);
			const lotCtx: Ctx = {
				...ctx,
				lot: {
					entryPrice: lot.entryPrice,
					openedAt: lot.openedAt,
					peak: peaks?.[lot.id] ?? lot.entryPrice,
				},
			};
			const done = lot.partialExitDone ?? false;
			const sl = evaluateGroup(rule.stopLoss, lotCtx);
			const tp = evaluateGroup(rule.takeProfit, lotCtx);
			// 一部利確は1ロットにつき1回だけ
			const partialQty = done
				? 0
				: partialSellQuantity(lot.quantity, rule.partialSell.percent);
			const ptp: GroupResult =
				partialQty > 0 && partialQty < lot.quantity
					? evaluateGroup(rule.partialTakeProfit, lotCtx)
					: { kind: "miss" };
			const short = [sl, tp, ptp].find((r) => r.kind === "insufficient");
			if (short?.kind === "insufficient") {
				lacking = short.why;
				break;
			}
			// 建値ストップ: 一部利確の後、現在値が買値を下回ったら残りを損切りとして売る
			const breakeven =
				done && rule.partialSell.breakevenStop && ctx.price < lot.entryPrice
					? `一部利確の後、現在値 ${formatYen(ctx.price)} が買値 ${formatYen(lot.entryPrice)} を下回った。`
					: null;
			const hit =
				sl.kind === "hit"
					? { why: sl.why, label: "損切り", exitKind: "stopLoss" as const }
					: breakeven !== null
						? { why: breakeven, label: "損切り", exitKind: "stopLoss" as const }
						: tp.kind === "hit"
							? { why: tp.why, label: "利確", exitKind: "takeProfit" as const }
							: ptp.kind === "hit"
								? {
										why: ptp.why,
										label: "一部利確",
										exitKind: "partialTakeProfit" as const,
									}
								: null;
			if (!hit) continue;
			const quantity =
				hit.exitKind === "partialTakeProfit" ? partialQty : lot.quantity;
			const what =
				(multi ? `「${rule.name}」で買った` : "") +
				(lots.length === 1
					? `保有中の ${formatBtc(lot.quantity)} BTC`
					: `買値 ${formatYen(lot.entryPrice)} のロット ${formatBtc(lot.quantity)} BTC`);
			const part =
				quantity < lot.quantity ? ` のうち ${formatBtc(quantity)} BTC` : "";
			sells.push(`${hit.why}${what}${part} を売却（${hit.label}の条件）`);
			if (cooldown && hit.exitKind === "stopLoss") stopLossAt = now;
			intents.push({
				kind: "place",
				side: "sell",
				type: "market",
				quantity,
				lotId: lot.id,
				exitKind: hit.exitKind,
			});
		}
		if (lacking !== null) {
			intents.length = 0;
			stopLossAt = cooldown ? prevStopLossAt(state) : null;
			notes.push(`指標の本数が足りないため判定しない（${lacking}）`);
		} else if (targets.length === 0) {
			notes.push("売り注文の約定待ち");
		} else if (sells.length === 0) {
			notes.push("売りの条件を満たさない");
		} else {
			notes.push(...sells);
		}
	}

	// 買い: 上の買いから順に、その買いの空き枠（最大ロット数 − その買いのロット − その買いの未約定の買い）があり、
	// その買いの未約定の買いが無いときだけ出す。注文を出せた買いより下の買いは出さない（1回の判定で出す買いは1つ）。
	// 空き枠は売る前の保有数で数える（売りで空く枠は次の判定から使う）
	const cooling = stopLossAt !== null && now < stopLossAt + cooldownMs;
	let placedBy: BuyRule | null = null;
	let cooldownNoted = false;
	for (const b of p.buys) {
		const mine = (buyId: string | null | undefined) =>
			buyRuleOf(p, buyId).id === b.id;
		const say = (text: string) =>
			notes.push(multi ? `【${b.name}】${text}` : text);
		const openBuys = openOrders.filter(
			(o) => o.side === "buy" && mine(o.buyId),
		).length;
		const free =
			b.maxPositions - lots.filter((l) => mine(l.buyId)).length - openBuys;
		// 最大ロット数が 2 以上なら、条件が続く間の連続買いを防ぐため、前回外れていたときだけ買う（1 は今までどおり）
		const edge = b.maxPositions >= 2;
		const check = () => {
			const r = evaluateGroup(b.buy, ctx);
			if (edge && r.kind !== "insufficient") {
				buyHits[b.id] = r.kind === "hit";
			}
			return r;
		};
		if (openBuys > 0) {
			if (edge) check();
			say("買い注文の約定待ち");
		} else if (free <= 0) {
			if (edge) {
				check();
				say(`最大ロット数 ${b.maxPositions} に達しているため買わない`);
			}
		} else if (cooling && stopLossAt !== null) {
			if (edge) check();
			if (!cooldownNoted) {
				const tfMs = TIMEFRAME_MS[p.stopLossCooldownTimeframe];
				const left = Math.ceil((stopLossAt + cooldownMs - now) / tfMs);
				notes.push(
					`損切りから${TIMEFRAME_LABELS[p.stopLossCooldownTimeframe]}で ${p.stopLossCooldownBars} 本経っていないため買わない（あと ${left} 本）`,
				);
				cooldownNoted = true;
			}
		} else {
			const wasHit = buyHits[b.id] ?? null;
			const r = check();
			if (r.kind === "insufficient") {
				say(`指標の本数が足りないため判定しない（${r.why}）`);
			} else if (r.kind === "miss") {
				say("買いの条件を満たさない");
			} else if (edge && wasHit === true) {
				say("買いの条件が続いているため買わない（一度外れてから買う）");
			} else if (placedBy !== null) {
				say(
					`買いの条件を満たすが、上の「${placedBy.name}」で注文したため買わない`,
				);
			} else {
				const placed = buyIntents(b, ctx.price, cash, free);
				for (const intent of placed.intents) {
					intents.push({
						...intent,
						buyId: b.id,
						...(multi ? { buyName: b.name } : {}),
					});
				}
				if (placed.intents.length > 0) placedBy = b;
				say(`${r.why}${placed.note}`);
			}
		}
	}

	const hasHits = Object.keys(buyHits).length > 0;
	const nextState: JsonValue =
		!hasHits && peaks === null && stopLossAt === null
			? null
			: {
					...(hasHits ? { buyHits } : {}),
					...(peaks === null ? {} : { peaks }),
					...(stopLossAt === null ? {} : { stopLossAt }),
				};
	return { intents, nextEvalAt, state: nextState, note: notes.join("。") };
}

/** 買い注文の行を、空き枠の数だけ先頭から注文にする。資金が足りなくなった行から先は出さない */
function buyIntents(
	b: BuyRule,
	price: number,
	cash: number,
	free: number,
): { intents: Extract<OrderIntent, { kind: "place" }>[]; note: string } {
	const { lines, expireBars, expireTimeframe } = b.buyOrder;
	const size = b.orderSize;
	const intents: Extract<OrderIntent, { kind: "place" }>[] = [];
	const texts: string[] = [];
	let total = 0;
	let short: string | null = null;
	for (const line of lines.slice(0, free)) {
		// 成行の約定価格は発注後に決まるので、判定時の現在値で見積もる
		const at =
			line.type === "market"
				? price
				: limitBuyPriceBelow(price, Math.round(line.belowPercent * 10_000));
		const cost = notionalYen(at, size, "ceil");
		if (cash < total + cost) {
			short =
				line.type === "market"
					? `資金 ${formatYen(cash - total)} 円が注文額の見積もり ${formatYen(cost)} 円に足りないため買わない`
					: `資金 ${formatYen(cash - total)} 円が注文額 ${formatYen(cost)} 円に足りないため買わない`;
			break;
		}
		total += cost;
		if (line.type === "market") {
			texts.push(`成行で ${formatBtc(size)} BTC を買い`);
			intents.push({
				kind: "place",
				side: "buy",
				type: "market",
				quantity: size,
			});
		} else {
			texts.push(
				`現在値 ${formatYen(price)} より ${line.belowPercent}% 下の ${formatYen(at)} に指値で ${formatBtc(size)} BTC を買い（${TIMEFRAME_LABELS[expireTimeframe]}で ${expireBars} 本のあいだ約定しなければ取消）`,
			);
			intents.push({
				kind: "place",
				side: "buy",
				type: "limit",
				price: at,
				quantity: size,
				expireAfterMs: expireBars * TIMEFRAME_MS[expireTimeframe],
			});
		}
	}
	if (intents.length === 0) {
		return { intents, note: short ?? "" };
	}
	const rest = short
		? `。残り ${Math.min(lines.length, free) - intents.length} 件は${short.replace(/ため買わない$/, "ため出さない")}`
		: "";
	return { intents, note: `${texts.join("、")}${rest}` };
}

export const conditionStrategy: Strategy<ConditionSet> = {
	id: "condition",
	requiredJudges,
	candleNeeds,
	recentMs,
	validate: validateConditionSet,
	evaluate: evaluateConditionSet,
	dailyLossLimit: (p) => p.dailyLossLimit,
};

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 条件・指値・損切り後の足。持たなければ、戦略が足の粒度を1つだけ持っていた頃の粒度（legacy）で読む。
 * どちらも無ければ値のまま返し、入力検証で弾く
 */
function timeframeOr(v: unknown, legacy: Timeframe | null): Timeframe {
	return (isTimeframe(v) ? v : (legacy ?? v)) as Timeframe;
}

/** 指値・損切り後の足。持つ前の戦略は条件と違って足に意味が無かったので、無ければ既定で読む */
function timeframeOrDefault(v: unknown, legacy: Timeframe | null): Timeframe {
	return v === undefined
		? (legacy ?? DEFAULT_CONDITION_TIMEFRAME)
		: timeframeOr(v, legacy);
}

function parseCondition(
	v: unknown,
	legacy: Timeframe | null,
): Condition | null {
	if (!isObj(v)) return null;
	const num = (x: unknown) => (typeof x === "number" ? x : Number.NaN);
	const timeframe = timeframeOr(v.timeframe, legacy);
	switch (v.type) {
		case "emaCross":
			if (v.direction !== "up" && v.direction !== "down") return null;
			return {
				type: "emaCross",
				timeframe,
				fast: num(v.fast),
				slow: num(v.slow),
				direction: v.direction,
			};
		case "breakout":
			if (v.direction !== "high" && v.direction !== "low") return null;
			return {
				type: "breakout",
				timeframe,
				lookback: num(v.lookback),
				direction: v.direction,
			};
		case "rsi":
			if (v.direction !== "above" && v.direction !== "below") return null;
			return {
				type: "rsi",
				timeframe,
				period: num(v.period),
				threshold: num(v.threshold),
				direction: v.direction,
			};
		case "rsiCross":
			if (v.direction !== "up" && v.direction !== "down") return null;
			return {
				type: "rsiCross",
				timeframe,
				period: num(v.period),
				threshold: num(v.threshold),
				bars: num(v.bars),
				direction: v.direction,
			};
		case "judgment":
			if (
				!(JUDGES as readonly unknown[]).includes(v.judge) ||
				!Array.isArray(v.values) ||
				!v.values.every((x) => typeof x === "string")
			) {
				return null;
			}
			return {
				type: "judgment",
				judge: v.judge as Judge,
				values: v.values as JudgmentConditionValue[],
			};
		case "entryChange":
			if (v.direction !== "up" && v.direction !== "down") return null;
			return {
				type: "entryChange",
				percent: num(v.percent),
				direction: v.direction,
			};
		case "emaPosition":
			if (v.direction !== "above" && v.direction !== "below") return null;
			return {
				type: "emaPosition",
				timeframe,
				period: num(v.period),
				direction: v.direction,
			};
		case "emaSlope":
			if (v.direction !== "up" && v.direction !== "down") return null;
			return {
				type: "emaSlope",
				timeframe,
				period: num(v.period),
				bars: num(v.bars),
				percent: num(v.percent),
				direction: v.direction,
			};
		case "bollinger":
			if (v.band !== "upper" && v.band !== "lower") return null;
			return {
				type: "bollinger",
				timeframe,
				period: num(v.period),
				sigma: num(v.sigma),
				band: v.band,
			};
		case "trailingStop":
			return {
				type: "trailingStop",
				percent: num(v.percent),
				// 発動の % を持つ前の条件は、買った直後から発動する
				activatePercent:
					v.activatePercent === undefined ? 0 : num(v.activatePercent),
			};
		case "holdingBars":
			return { type: "holdingBars", timeframe, bars: num(v.bars) };
		default:
			return null;
	}
}

function parseGroup(
	v: unknown,
	legacy: Timeframe | null,
): ConditionGroup | null {
	if (
		!isObj(v) ||
		(v.match !== "all" && v.match !== "any") ||
		!Array.isArray(v.conditions)
	) {
		return null;
	}
	const conditions = v.conditions.map((c) => parseCondition(c, legacy));
	return conditions.every((c) => c !== null)
		? { match: v.match, conditions: conditions as Condition[] }
		: null;
}

function parseBuyOrderLine(v: unknown): BuyOrderLine | null {
	if (!isObj(v)) return null;
	if (v.type === "market") return { type: "market" };
	if (v.type !== "limit") return null;
	return {
		type: "limit",
		belowPercent:
			typeof v.belowPercent === "number" ? v.belowPercent : Number.NaN,
	};
}

/**
 * 無ければ既定の出し方（保存済みの戦略が持っていない）。
 * 行を持つ前の形（type・belowPercent・expireBars）は、その注文方法の1行として読む
 */
function parseBuyOrder(v: unknown, legacy: Timeframe | null): BuyOrder | null {
	if (v === undefined) {
		return {
			...DEFAULT_BUY_ORDER,
			lines: DEFAULT_BUY_ORDER.lines.map((l) => ({ ...l })),
			expireTimeframe: legacy ?? DEFAULT_BUY_ORDER.expireTimeframe,
		};
	}
	if (!isObj(v)) return null;
	const expireBars =
		typeof v.expireBars === "number" ? v.expireBars : Number.NaN;
	const expireTimeframe = timeframeOrDefault(v.expireTimeframe, legacy);
	if (v.lines === undefined) {
		const line = parseBuyOrderLine(v);
		return line ? { lines: [line], expireBars, expireTimeframe } : null;
	}
	if (!Array.isArray(v.lines)) return null;
	const lines = v.lines.map(parseBuyOrderLine);
	return lines.every((l) => l !== null)
		? { lines: lines as BuyOrderLine[], expireBars, expireTimeframe }
		: null;
}

/** 無ければ既定の売り方（保存済みの戦略が持っていない） */
function parsePartialSell(v: unknown): PartialSell | null {
	if (v === undefined) return { ...DEFAULT_PARTIAL_SELL };
	if (!isObj(v)) return null;
	return {
		percent: typeof v.percent === "number" ? v.percent : Number.NaN,
		breakevenStop: v.breakevenStop === true,
	};
}

function parseFrequency(v: unknown): Frequency | null {
	if (!isObj(v) || !FREQUENCY_UNITS.includes(v.unit as FrequencyUnit))
		return null;
	return {
		value: typeof v.value === "number" ? v.value : Number.NaN,
		unit: v.unit as FrequencyUnit,
	};
}

/** 買い1つ（の売り方を含む部分）を読む。買いを持つ前の戦略は、条件セットそのものをこの形で読む */
function parseBuyRuleBody(
	v: Record<string, unknown>,
	legacy: Timeframe | null,
): Omit<BuyRule, "id" | "name"> | null {
	const buy = parseGroup(v.buy, legacy);
	// 一部利確の条件を持つ前の戦略は空として読む
	const partialTakeProfit =
		v.partialTakeProfit === undefined
			? { match: "all" as const, conditions: [] }
			: parseGroup(v.partialTakeProfit, legacy);
	const partialSell = parsePartialSell(v.partialSell);
	const takeProfit = parseGroup(v.takeProfit, legacy);
	const stopLoss = parseGroup(v.stopLoss, legacy);
	const buyOrder = parseBuyOrder(v.buyOrder, legacy);
	if (
		!buy ||
		!buyOrder ||
		!partialTakeProfit ||
		!partialSell ||
		!takeProfit ||
		!stopLoss
	)
		return null;
	return {
		orderSize: typeof v.orderSize === "number" ? v.orderSize : Number.NaN,
		maxPositions:
			v.maxPositions === undefined
				? DEFAULT_MAX_POSITIONS
				: typeof v.maxPositions === "number"
					? v.maxPositions
					: Number.NaN,
		buy,
		buyOrder,
		partialTakeProfit,
		partialSell,
		takeProfit,
		stopLoss,
	};
}

/**
 * JSON などから受け取った値を条件セットの形に読む。形が違えば null。
 * 値の範囲は見ない（validateConditionSet で検証する）。
 * 買いを持つ前の形（買い・売りの条件を条件セットに直接持つ）は、買い1つとして読む
 */
export function parseConditionSet(v: unknown): ConditionSet | null {
	if (!isObj(v) || !isObj(v.frequency)) return null;
	// 戦略が足の粒度を1つだけ持っていた頃の形。条件・指値・損切り後の足をこの粒度で埋める
	const legacy = isTimeframe(v.timeframe) ? v.timeframe : null;
	const flat = parseFrequency(v.frequency.flat);
	const holding = parseFrequency(v.frequency.holding);
	if (!flat || !holding) return null;
	let buys: BuyRule[];
	if (v.buys === undefined) {
		const body = parseBuyRuleBody(v, legacy);
		if (!body) return null;
		buys = [{ id: "b1", name: buyRuleName(1), ...body }];
	} else {
		if (!Array.isArray(v.buys)) return null;
		const parsed = v.buys.map((b): BuyRule | null => {
			if (!isObj(b) || typeof b.id !== "string" || typeof b.name !== "string")
				return null;
			const body = parseBuyRuleBody(b, legacy);
			return body ? { id: b.id, name: b.name, ...body } : null;
		});
		if (parsed.some((b) => b === null)) return null;
		buys = parsed as BuyRule[];
	}
	return {
		frequency: { flat, holding },
		dailyLossLimit:
			v.dailyLossLimit === undefined
				? DEFAULT_DAILY_LOSS_LIMIT
				: typeof v.dailyLossLimit === "number"
					? v.dailyLossLimit
					: Number.NaN,
		stopLossCooldownBars:
			v.stopLossCooldownBars === undefined
				? DEFAULT_STOP_LOSS_COOLDOWN_BARS
				: typeof v.stopLossCooldownBars === "number"
					? v.stopLossCooldownBars
					: Number.NaN,
		stopLossCooldownTimeframe: timeframeOrDefault(
			v.stopLossCooldownTimeframe,
			legacy,
		),
		buys,
	};
}
