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
import { isCoarser, isTimeframe, TIMEFRAME_MS, TIMEFRAMES } from "./timeframe";
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
	| { type: "emaCross"; fast: number; slow: number; direction: "up" | "down" }
	/** 終値が直近 N 本の最高値を上抜けた（high）/ 最安値を下抜けた（low） */
	| { type: "breakout"; lookback: number; direction: "high" | "low" }
	/** RSI(period) が threshold 以上（above）/ 以下（below）。どのグループでも使える */
	| {
			type: "rsi";
			period: number;
			threshold: number;
			direction: "above" | "below";
	  }
	/** 終値が EMA(period) より上（above）/ 下（below）。どのグループでも使える */
	| { type: "emaPosition"; period: number; direction: "above" | "below" }
	/** EMA(period) が bars 本前から percent % 以上 上がった（up）/ 下がった（down）。percent が 0 なら向きだけを見る。どのグループでも使える */
	| {
			type: "emaSlope";
			period: number;
			bars: number;
			percent: number;
			direction: "up" | "down";
	  }
	/** 終値がボリンジャーバンド（period 本・sigma σ）の上限以上（upper）/ 下限以下（lower）。どのグループでも使える */
	| {
			type: "bollinger";
			period: number;
			sigma: number;
			band: "upper" | "lower";
	  }
	/** 現在値が買値から percent % 上がった（up）/ 下がった（down）。売りのグループだけで使える */
	| { type: "entryChange"; percent: number; direction: "up" | "down" }
	/** 現在値が買ってからの最高値から percent % 下がった。売りのグループだけで使える */
	| { type: "trailingStop"; percent: number }
	/** 買ってから戦略の粒度の足で bars 本経った。売りのグループだけで使える */
	| { type: "holdingBars"; bars: number }
	/** AI の判定が values のどれか。判定がまだ無いときは values に NO_JUDGMENT があれば成立。どのグループでも使える */
	| { type: "judgment"; judge: Judge; values: JudgmentConditionValue[] };

export type ConditionType = Condition["type"];

export type ConditionGroup = {
	/** all: すべて満たす / any: どれか1つ */
	match: "all" | "any";
	conditions: Condition[];
};

export const CONDITION_GROUPS = ["buy", "takeProfit", "stopLoss"] as const;
export type ConditionGroupKey = (typeof CONDITION_GROUPS)[number];

export const CONDITION_GROUP_LABELS: Record<ConditionGroupKey, string> = {
	buy: "買い注文する条件",
	takeProfit: "売り注文（利確）する条件",
	stopLoss: "売り注文（損切り）する条件",
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
	/** 指値をこの本数のあいだ約定しなければ取り消す。成行には効かない */
	expireBars: number;
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
};

/** 成行1件で買う出し方 */
export const MARKET_BUY_ORDER: BuyOrder = {
	lines: [{ type: "market" }],
	expireBars: DEFAULT_BUY_ORDER.expireBars,
};

/** 最大ロット数の既定。これを持たない保存済みの戦略もこの数で読む */
export const DEFAULT_MAX_POSITIONS = 1;

export type ConditionSet = {
	/** EMA・RSI の本数・直近 N 本・指値の取消までの本数は、すべてこの粒度の足で数える */
	timeframe: Timeframe;
	frequency: {
		/** 保有なしのとき */
		flat: Frequency;
		/** 保有中のとき */
		holding: Frequency;
	};
	/** 1回の注文量（satoshi）。1ロットの量 */
	orderSize: number;
	/** 同時に持てるロットの数（未約定の買い注文を含む） */
	maxPositions: number;
	/** 1日の損失上限（円）。その日の確定損失がこれに達したら新しい買いを止める */
	dailyLossLimit: number;
	buy: ConditionGroup;
	buyOrder: BuyOrder;
	takeProfit: ConditionGroup;
	stopLoss: ConditionGroup;
};

export const LIMITS = {
	emaPeriod: { min: 2, max: 500 },
	lookback: { min: 2, max: 1000 },
	rsiPeriod: { min: 2, max: 100 },
	rsiThreshold: { min: 1, max: 99 },
	bollingerPeriod: { min: 2, max: 500 },
	/** ボリンジャーバンドの σ。0.1 刻み */
	bollingerSigma: { min: 0.1, max: 5 },
	percent: { min: 0.1, max: 100 },
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
} as const;

/** 1日の損失上限の既定（仮置き）。これを持たない保存済みの戦略もこの上限で読む */
export const DEFAULT_DAILY_LOSS_LIMIT = 30_000;

/** EMA・RSI を途中から計算しても値がほぼ一致するよう、本数のこの倍の足を渡してもらう */
const EMA_HISTORY_FACTOR = 10;

type Hit = { ok: true; why: string } | { ok: false } | { insufficient: string };

type Ctx = {
	candles: readonly Candle[];
	/** 判定器ごとの今の判定。まだ無ければ入らない */
	judgments: Partial<Record<Judge, JudgmentValue>>;
	closes: number[];
	price: number;
	now: number;
	timeframeMs: number;
	/** 売りの判定中のロット。買いの判定では null */
	lot: { entryPrice: number; openedAt: number; peak: number } | null;
	emaCache: Map<number, number[]>;
	rsiCache: Map<number, number[]>;
	bollingerCache: Map<string, ReturnType<typeof bollinger>>;
};

function emaOf(ctx: Ctx, period: number): number[] {
	let v = ctx.emaCache.get(period);
	if (!v) {
		v = ema(ctx.closes, period);
		ctx.emaCache.set(period, v);
	}
	return v;
}

function rsiOf(ctx: Ctx, period: number): number[] {
	let v = ctx.rsiCache.get(period);
	if (!v) {
		v = rsi(ctx.closes, period);
		ctx.rsiCache.set(period, v);
	}
	return v;
}

/** RSI の見せ方。小数1桁 */
export const formatRsi = (v: number) => v.toFixed(1);

function checkCondition(c: Condition, ctx: Ctx): Hit {
	const n = ctx.candles.length;
	switch (c.type) {
		case "emaCross": {
			const need = c.slow + 1;
			if (n < need) {
				return {
					insufficient: `EMA(${c.slow}) に ${need} 本必要、現在 ${n} 本`,
				};
			}
			const f = emaOf(ctx, c.fast);
			const s = emaOf(ctx, c.slow);
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
						why: `短期EMA(${c.fast}) ${formatYen(f1)} が長期EMA(${c.slow}) ${formatYen(s1)} を${c.direction === "up" ? "上抜け" : "下抜け"}`,
					}
				: { ok: false };
		}
		case "breakout": {
			const need = c.lookback + 1;
			if (n < need) {
				return {
					insufficient: `直近 ${c.lookback} 本に ${need} 本必要、現在 ${n} 本`,
				};
			}
			// 現在の足を除く直近 N 本
			const window = ctx.candles.slice(n - 1 - c.lookback, n - 1);
			if (c.direction === "high") {
				const high = Math.max(...window.map((x) => x.high));
				return ctx.price > high
					? {
							ok: true,
							why: `終値 ${formatYen(ctx.price)} が直近 ${c.lookback} 本の最高値 ${formatYen(high)} を上抜け`,
						}
					: { ok: false };
			}
			const low = Math.min(...window.map((x) => x.low));
			return ctx.price < low
				? {
						ok: true,
						why: `終値 ${formatYen(ctx.price)} が直近 ${c.lookback} 本の最安値 ${formatYen(low)} を下抜け`,
					}
				: { ok: false };
		}
		case "rsi": {
			const need = c.period + 1;
			if (n < need) {
				return {
					insufficient: `RSI(${c.period}) に ${need} 本必要、現在 ${n} 本`,
				};
			}
			const v = rsiOf(ctx, c.period)[n - 1] as number;
			const hit = c.direction === "above" ? v >= c.threshold : v <= c.threshold;
			return hit
				? {
						ok: true,
						why: `RSI(${c.period}) ${formatRsi(v)} が ${c.threshold} ${c.direction === "above" ? "以上" : "以下"}`,
					}
				: { ok: false };
		}
		case "emaPosition": {
			if (n < c.period) {
				return {
					insufficient: `EMA(${c.period}) に ${c.period} 本必要、現在 ${n} 本`,
				};
			}
			const v = emaOf(ctx, c.period)[n - 1] as number;
			const hit = c.direction === "above" ? ctx.price > v : ctx.price < v;
			return hit
				? {
						ok: true,
						why: `終値 ${formatYen(ctx.price)} が EMA(${c.period}) ${formatYen(v)} より${c.direction === "above" ? "上" : "下"}`,
					}
				: { ok: false };
		}
		case "emaSlope": {
			const need = c.period + c.bars;
			if (n < need) {
				return {
					insufficient: `EMA(${c.period}) の ${c.bars} 本前比に ${need} 本必要、現在 ${n} 本`,
				};
			}
			const e = emaOf(ctx, c.period);
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
						why: `EMA(${c.period}) ${formatYen(now)} は ${c.bars} 本前 ${formatYen(before)} から ${sign}${Math.abs(change).toFixed(2)}%${target}`,
					}
				: { ok: false };
		}
		case "bollinger": {
			if (n < c.period) {
				return {
					insufficient: `ボリンジャーバンド(${c.period}) に ${c.period} 本必要、現在 ${n} 本`,
				};
			}
			const key = `${c.period}:${c.sigma}`;
			let b = ctx.bollingerCache.get(key);
			if (!b) {
				b = bollinger(ctx.closes, c.period, c.sigma);
				ctx.bollingerCache.set(key, b);
			}
			const name = `ボリンジャーバンド(${c.period}本・${c.sigma}σ)`;
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
		case "judgment": {
			const v = ctx.judgments[c.judge];
			const name = `${JUDGE_LABELS[c.judge]}判定`;
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
			const { peak } = ctx.lot;
			const drop = (1 - ctx.price / peak) * 100;
			return drop >= c.percent
				? {
						ok: true,
						why: `現在値 ${formatYen(ctx.price)} は買ってからの最高値 ${formatYen(peak)} から −${drop.toFixed(1)}%（−${c.percent}% 以上）`,
					}
				: { ok: false };
		}
		case "holdingBars": {
			if (ctx.lot === null) {
				return { ok: false };
			}
			const bars = Math.floor((ctx.now - ctx.lot.openedAt) / ctx.timeframeMs);
			return bars >= c.bars
				? { ok: true, why: `買ってから ${bars} 本経過（${c.bars} 本以上）` }
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

/**
 * 判定頻度どおりに判定するのに要る足の粒度。両方の判定頻度を割り切れる粒度のうち最も粗いもの（戦略の粒度が上限）。
 * 1分の倍数でない頻度（秒単位）はどの粒度でも割り切れないので null
 */
export function idealStepTimeframe(params: ConditionSet): Timeframe | null {
	const g = gcd(
		frequencyMs(params.frequency.flat),
		frequencyMs(params.frequency.holding),
	);
	const cap = TIMEFRAME_MS[params.timeframe];
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

/** 戦略が使う EMA の本数（小さい順、重複なし）。チャートの EMA 線に使う */
export function emaPeriods(params: ConditionSet): number[] {
	const set = new Set<number>();
	for (const key of CONDITION_GROUPS) {
		for (const c of params[key].conditions) {
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

/** 戦略が使う RSI の本数ごとの、条件のしきい値（本数・しきい値とも小さい順、重複なし）。チャートの RSI に使う */
export function rsiLines(
	params: ConditionSet,
): { period: number; thresholds: number[] }[] {
	const map = new Map<number, Set<number>>();
	for (const key of CONDITION_GROUPS) {
		for (const c of params[key].conditions) {
			if (c.type === "rsi") {
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
	for (const key of CONDITION_GROUPS) {
		for (const c of params[key].conditions) {
			if (c.type === "judgment") used.add(c.judge);
		}
	}
	return JUDGES.filter((j) => used.has(j));
}

/** 判定の条件のどれかで「データなし」を選んでいるか。採点の記録が始まる前を含む期間のバックテストはこれが true のときだけ実行する */
export function acceptsNoJudgment(params: ConditionSet): boolean {
	return CONDITION_GROUPS.some((key) =>
		params[key].conditions.some(
			(c) =>
				c.type === "judgment" && (c.values as string[]).includes(NO_JUDGMENT),
		),
	);
}

/** 判定に渡してほしい足の本数（現在の足を含む） */
export function historyBars(params: ConditionSet): number {
	let n = 1;
	for (const key of CONDITION_GROUPS) {
		for (const c of params[key].conditions) {
			if (c.type === "emaCross") {
				n = Math.max(n, c.slow * EMA_HISTORY_FACTOR + 1);
			} else if (c.type === "emaPosition" || c.type === "rsi") {
				n = Math.max(n, c.period * EMA_HISTORY_FACTOR + 1);
			} else if (c.type === "emaSlope") {
				n = Math.max(n, c.period * EMA_HISTORY_FACTOR + c.bars + 1);
			} else if (c.type === "breakout") {
				n = Math.max(n, c.lookback + 1);
			} else if (c.type === "bollinger") {
				n = Math.max(n, c.period);
			} else if (c.type === "trailingStop") {
				// 前回の判定から今回までの足をすべて見て、最高値を取りこぼさないようにする
				const between = Math.ceil(
					frequencyMs(params.frequency.holding) /
						TIMEFRAME_MS[params.timeframe],
				);
				n = Math.max(n, between + 1);
			}
		}
	}
	return n;
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

/** 条件セットの入力検証。path は「buy.conditions.0.fast」のようにフォームの項目を指す */
export function validateConditionSet(p: ConditionSet): ValidationError[] {
	const errors: ValidationError[] = [];
	const err = (path: string, message: string) => errors.push({ path, message });

	if (!isTimeframe(p.timeframe)) {
		err("timeframe", "足の粒度を選ぶ");
	}
	const size = LIMITS.orderSize;
	if (!isIntIn(p.orderSize, size)) {
		err(
			"orderSize",
			`${formatBtc(size.min)}〜${formatBtc(size.max)} BTC の範囲で入れる（最小単位 0.00000001）`,
		);
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
	for (const g of CONDITION_GROUPS) {
		p[g].conditions.forEach((c, i) => {
			const at = `${g}.conditions.${i}`;
			const range = (r: { min: number; max: number }) => `${r.min}〜${r.max}`;
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
				case "trailingStop":
					if (g === "buy") {
						err(at, "最高値からの % は売りの条件だけで使える");
					} else if (!isNumIn(c.percent, LIMITS.percent)) {
						err(`${at}.percent`, `${range(LIMITS.percent)} の範囲で入れる`);
					}
					break;
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
	if (p.stopLoss.conditions.length === 0) {
		err(
			"stopLoss",
			"損切りの条件が無いと、下がり続けても売らない。1つ以上追加する",
		);
	}
	return errors;
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

/** 前回の判定で買いの条件が成立していたか。まだ判定していなければ null */
function prevBuyHit(state: JsonValue): boolean | null {
	return isObj(state) && typeof state.buyHit === "boolean"
		? state.buyHit
		: null;
}

function usesCondition(p: ConditionSet, type: ConditionType): boolean {
	return CONDITION_GROUPS.some((k) =>
		p[k].conditions.some((c) => c.type === type),
	);
}

/**
 * ロットごとの、買ってからの最高値。前回までの最高値（state）と、渡された足のうち約定より後の値動きから求める。
 * state は自動取引をオンにし直すと消えるため、足だけでも求められる形にしている
 */
function lotPeaks(
	lots: StrategyInput<ConditionSet>["lots"],
	candles: readonly Candle[],
	timeframeMs: number,
	state: JsonValue,
): Record<string, number> {
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

	const last = candles.at(-1);
	if (!last) {
		return { intents: [], nextEvalAt, state, note: "足が無いため判定しない" };
	}
	const timeframeMs = TIMEFRAME_MS[p.timeframe];
	const ctx: Ctx = {
		candles,
		closes: candles.map((c) => c.close),
		price: last.close,
		now,
		timeframeMs,
		lot: null,
		emaCache: new Map(),
		rsiCache: new Map(),
		bollingerCache: new Map(),
		judgments: latestJudgments(judgments),
	};
	const intents: OrderIntent[] = [];
	const notes: string[] = [];
	let buyHit = prevBuyHit(state);
	const peaks = usesCondition(p, "trailingStop")
		? lotPeaks(lots, candles, timeframeMs, state)
		: null;

	// 売り: ロットごとに判定する。同じ判定で利確と損切りの両方が成立したら損切りを優先する（損失を小さく見積もらないため）
	if (holding) {
		const selling = new Set(
			openOrders.filter((o) => o.side === "sell").map((o) => o.lotId),
		);
		const targets = lots.filter((l) => !selling.has(l.id));
		const sells: string[] = [];
		let lacking: string | null = null;
		for (const lot of targets) {
			const lotCtx: Ctx = {
				...ctx,
				lot: {
					entryPrice: lot.entryPrice,
					openedAt: lot.openedAt,
					peak: peaks?.[lot.id] ?? lot.entryPrice,
				},
			};
			const sl = evaluateGroup(p.stopLoss, lotCtx);
			const tp = evaluateGroup(p.takeProfit, lotCtx);
			const short = [sl, tp].find((r) => r.kind === "insufficient");
			if (short?.kind === "insufficient") {
				lacking = short.why;
				break;
			}
			const hit =
				sl.kind === "hit"
					? { why: sl.why, label: "損切り", exitKind: "stopLoss" as const }
					: tp.kind === "hit"
						? { why: tp.why, label: "利確", exitKind: "takeProfit" as const }
						: null;
			if (!hit) continue;
			const what =
				lots.length === 1
					? `保有中の ${formatBtc(lot.quantity)} BTC`
					: `買値 ${formatYen(lot.entryPrice)} のロット ${formatBtc(lot.quantity)} BTC`;
			sells.push(`${hit.why}${what} を売却（${hit.label}の条件）`);
			intents.push({
				kind: "place",
				side: "sell",
				type: "market",
				quantity: lot.quantity,
				lotId: lot.id,
				exitKind: hit.exitKind,
			});
		}
		if (lacking !== null) {
			intents.length = 0;
			notes.push(`指標の本数が足りないため判定しない（${lacking}）`);
		} else if (targets.length === 0) {
			notes.push("売り注文の約定待ち");
		} else if (sells.length === 0) {
			notes.push("売りの条件を満たさない");
		} else {
			notes.push(...sells);
		}
	}

	// 買い: 空き枠（最大ロット数 − 保有ロット − 未約定の買い）があり、未約定の買いが無いときだけ出す。
	// 空き枠は売る前の保有数で数える（売りで空く枠は次の判定から使う）
	const openBuys = openOrders.filter((o) => o.side === "buy").length;
	const free = p.maxPositions - lots.length - openBuys;
	// 最大ロット数が 2 以上なら、条件が続く間の連続買いを防ぐため、前回外れていたときだけ買う（1 は今までどおり）
	const edge = p.maxPositions >= 2;
	const buyCheck = () => {
		const r = evaluateGroup(p.buy, ctx);
		if (edge && r.kind !== "insufficient") {
			buyHit = r.kind === "hit";
		}
		return r;
	};
	if (openBuys > 0) {
		if (edge) buyCheck();
		notes.push("買い注文の約定待ち");
	} else if (free <= 0) {
		if (edge) {
			buyCheck();
			notes.push(`最大ロット数 ${p.maxPositions} に達しているため買わない`);
		}
	} else {
		const wasHit = buyHit;
		const r = buyCheck();
		if (r.kind === "insufficient") {
			notes.push(`指標の本数が足りないため判定しない（${r.why}）`);
		} else if (r.kind === "miss") {
			notes.push("買いの条件を満たさない");
		} else if (edge && wasHit === true) {
			notes.push("買いの条件が続いているため買わない（一度外れてから買う）");
		} else {
			const placed = buyIntents(p, ctx.price, cash, free);
			intents.push(...placed.intents);
			notes.push(`${r.why}${placed.note}`);
		}
	}

	const nextState: JsonValue =
		buyHit === null && peaks === null
			? null
			: {
					...(buyHit === null ? {} : { buyHit }),
					...(peaks === null ? {} : { peaks }),
				};
	return { intents, nextEvalAt, state: nextState, note: notes.join("。") };
}

/** 買い注文の行を、空き枠の数だけ先頭から注文にする。資金が足りなくなった行から先は出さない */
function buyIntents(
	p: ConditionSet,
	price: number,
	cash: number,
	free: number,
): { intents: OrderIntent[]; note: string } {
	const { lines, expireBars } = p.buyOrder;
	const size = p.orderSize;
	const intents: OrderIntent[] = [];
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
				`現在値 ${formatYen(price)} より ${line.belowPercent}% 下の ${formatYen(at)} に指値で ${formatBtc(size)} BTC を買い（${expireBars} 本のあいだ約定しなければ取消）`,
			);
			intents.push({
				kind: "place",
				side: "buy",
				type: "limit",
				price: at,
				quantity: size,
				expireAfterBars: expireBars,
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
	minResolution: (p) => p.timeframe,
	historyBars,
	validate: validateConditionSet,
	evaluate: evaluateConditionSet,
	dailyLossLimit: (p) => p.dailyLossLimit,
};

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

function parseCondition(v: unknown): Condition | null {
	if (!isObj(v)) return null;
	const num = (x: unknown) => (typeof x === "number" ? x : Number.NaN);
	switch (v.type) {
		case "emaCross":
			if (v.direction !== "up" && v.direction !== "down") return null;
			return {
				type: "emaCross",
				fast: num(v.fast),
				slow: num(v.slow),
				direction: v.direction,
			};
		case "breakout":
			if (v.direction !== "high" && v.direction !== "low") return null;
			return {
				type: "breakout",
				lookback: num(v.lookback),
				direction: v.direction,
			};
		case "rsi":
			if (v.direction !== "above" && v.direction !== "below") return null;
			return {
				type: "rsi",
				period: num(v.period),
				threshold: num(v.threshold),
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
				period: num(v.period),
				direction: v.direction,
			};
		case "emaSlope":
			if (v.direction !== "up" && v.direction !== "down") return null;
			return {
				type: "emaSlope",
				period: num(v.period),
				bars: num(v.bars),
				percent: num(v.percent),
				direction: v.direction,
			};
		case "bollinger":
			if (v.band !== "upper" && v.band !== "lower") return null;
			return {
				type: "bollinger",
				period: num(v.period),
				sigma: num(v.sigma),
				band: v.band,
			};
		case "trailingStop":
			return { type: "trailingStop", percent: num(v.percent) };
		case "holdingBars":
			return { type: "holdingBars", bars: num(v.bars) };
		default:
			return null;
	}
}

function parseGroup(v: unknown): ConditionGroup | null {
	if (
		!isObj(v) ||
		(v.match !== "all" && v.match !== "any") ||
		!Array.isArray(v.conditions)
	) {
		return null;
	}
	const conditions = v.conditions.map(parseCondition);
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
function parseBuyOrder(v: unknown): BuyOrder | null {
	if (v === undefined) {
		return {
			...DEFAULT_BUY_ORDER,
			lines: DEFAULT_BUY_ORDER.lines.map((l) => ({ ...l })),
		};
	}
	if (!isObj(v)) return null;
	const expireBars =
		typeof v.expireBars === "number" ? v.expireBars : Number.NaN;
	if (v.lines === undefined) {
		const line = parseBuyOrderLine(v);
		return line ? { lines: [line], expireBars } : null;
	}
	if (!Array.isArray(v.lines)) return null;
	const lines = v.lines.map(parseBuyOrderLine);
	return lines.every((l) => l !== null)
		? { lines: lines as BuyOrderLine[], expireBars }
		: null;
}

function parseFrequency(v: unknown): Frequency | null {
	if (!isObj(v) || !FREQUENCY_UNITS.includes(v.unit as FrequencyUnit))
		return null;
	return {
		value: typeof v.value === "number" ? v.value : Number.NaN,
		unit: v.unit as FrequencyUnit,
	};
}

/**
 * JSON などから受け取った値を条件セットの形に読む。形が違えば null。
 * 値の範囲は見ない（validateConditionSet で検証する）
 */
export function parseConditionSet(v: unknown): ConditionSet | null {
	if (!isObj(v) || !isTimeframe(v.timeframe) || !isObj(v.frequency))
		return null;
	const flat = parseFrequency(v.frequency.flat);
	const holding = parseFrequency(v.frequency.holding);
	const buy = parseGroup(v.buy);
	const takeProfit = parseGroup(v.takeProfit);
	const stopLoss = parseGroup(v.stopLoss);
	const buyOrder = parseBuyOrder(v.buyOrder);
	if (!flat || !holding || !buy || !buyOrder || !takeProfit || !stopLoss)
		return null;
	return {
		timeframe: v.timeframe,
		frequency: { flat, holding },
		orderSize: typeof v.orderSize === "number" ? v.orderSize : Number.NaN,
		maxPositions:
			v.maxPositions === undefined
				? DEFAULT_MAX_POSITIONS
				: typeof v.maxPositions === "number"
					? v.maxPositions
					: Number.NaN,
		dailyLossLimit:
			v.dailyLossLimit === undefined
				? DEFAULT_DAILY_LOSS_LIMIT
				: typeof v.dailyLossLimit === "number"
					? v.dailyLossLimit
					: Number.NaN,
		buy,
		buyOrder,
		takeProfit,
		stopLoss,
	};
}
