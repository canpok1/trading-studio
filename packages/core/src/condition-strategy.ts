// 画面で作る「条件のセット」を実行する汎用の条件戦略

import { formatBtc, formatYen } from "./format";
import { ema } from "./indicators";
import { limitBuyPriceBelow, notionalYen, SATOSHI_PER_BTC } from "./money";
import type { Judge, JudgmentValue } from "./news-judgment";
import {
	JUDGE_LABELS,
	JUDGES,
	JUDGMENT_VALUE_LABELS,
	JUDGMENT_VALUES,
} from "./news-judgment";
import type {
	Strategy,
	StrategyInput,
	StrategyOutput,
	ValidationError,
} from "./strategy";
import type { Timeframe } from "./timeframe";
import { isCoarser, isTimeframe, TIMEFRAME_MS, TIMEFRAMES } from "./timeframe";
import type { Candle, OrderIntent, OrderType } from "./types";

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
	/** 現在値が買値から percent % 上がった（up）/ 下がった（down）。売りのグループだけで使える */
	| { type: "entryChange"; percent: number; direction: "up" | "down" }
	/** AI の判定が values のどれか。どのグループでも使える */
	| { type: "judgment"; judge: Judge; values: JudgmentValue[] };

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

/** 買い注文の出し方。売りは常に成行 */
export type BuyOrder = {
	type: OrderType;
	/** 指値を現在値から何 % 下に出すか。成行では使わない */
	belowPercent: number;
	/** 指値をこの本数のあいだ約定しなければ取り消す。成行では使わない */
	expireBars: number;
};

export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
	limit: "指値",
	market: "成行",
};

/** 買い注文の出し方の既定。これを持たない保存済みの戦略もこの出し方で読む */
export const DEFAULT_BUY_ORDER: BuyOrder = {
	type: "limit",
	belowPercent: 0.1,
	expireBars: 3,
};

export type ConditionSet = {
	/** EMA の本数・直近 N 本・指値の取消までの本数は、すべてこの粒度の足で数える */
	timeframe: Timeframe;
	frequency: {
		/** ポジションなしのとき */
		flat: Frequency;
		/** ポジションありのとき */
		holding: Frequency;
	};
	/** 1回の注文量（satoshi） */
	orderSize: number;
	buy: ConditionGroup;
	buyOrder: BuyOrder;
	takeProfit: ConditionGroup;
	stopLoss: ConditionGroup;
};

export const LIMITS = {
	emaPeriod: { min: 2, max: 500 },
	lookback: { min: 2, max: 1000 },
	percent: { min: 0.1, max: 100 },
	/** 買い指値を現在値から下げる %。0 以上 100 未満、0.01 刻み */
	buyBelowPercent: { min: 0, maxExclusive: 100 },
	buyExpireBars: { min: 1, max: 100 },
	frequency: { min: 1, max: 999 },
	/** 注文量（satoshi）。0.001〜1 BTC */
	orderSize: { min: 100_000, max: SATOSHI_PER_BTC },
} as const;

/** EMA を途中から計算しても値がほぼ一致するよう、本数のこの倍の足を渡してもらう */
const EMA_HISTORY_FACTOR = 10;

type Hit = { ok: true; why: string } | { ok: false } | { insufficient: string };

type Ctx = {
	candles: readonly Candle[];
	/** 判定器ごとの今の判定。まだ無ければ入らない */
	judgments: Partial<Record<Judge, JudgmentValue>>;
	closes: number[];
	price: number;
	entryPrice: number | null;
	emaCache: Map<number, number[]>;
};

function emaOf(ctx: Ctx, period: number): number[] {
	let v = ctx.emaCache.get(period);
	if (!v) {
		v = ema(ctx.closes, period);
		ctx.emaCache.set(period, v);
	}
	return v;
}

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
		case "judgment": {
			const v = ctx.judgments[c.judge];
			const name = `${JUDGE_LABELS[c.judge]}判定`;
			if (v === undefined) {
				return { insufficient: `${name}がまだ無い` };
			}
			const label = (x: JudgmentValue) => JUDGMENT_VALUE_LABELS[x] ?? x;
			return (c.values as string[]).includes(v)
				? {
						ok: true,
						why: `${name}が${label(v)}（${c.values.map(label).join("・")}のどれか）`,
					}
				: { ok: false };
		}
		case "entryChange": {
			if (ctx.entryPrice === null) {
				return { ok: false };
			}
			const change = (ctx.price / ctx.entryPrice - 1) * 100;
			const hit =
				c.direction === "up" ? change >= c.percent : -change >= c.percent;
			const sign = change >= 0 ? "+" : "−";
			return hit
				? {
						ok: true,
						why: `現在値 ${formatYen(ctx.price)} は買値 ${formatYen(ctx.entryPrice)} から ${sign}${Math.abs(change).toFixed(1)}%（${c.direction === "up" ? "+" : "−"}${c.percent}% 以上）`,
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
			}
		}
	}
	return [...set].sort((a, b) => a - b);
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

/** 判定に渡してほしい足の本数（現在の足を含む） */
export function historyBars(params: ConditionSet): number {
	let n = 1;
	for (const key of CONDITION_GROUPS) {
		for (const c of params[key].conditions) {
			if (c.type === "emaCross") {
				n = Math.max(n, c.slow * EMA_HISTORY_FACTOR + 1);
			} else if (c.type === "breakout") {
				n = Math.max(n, c.lookback + 1);
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
				case "judgment": {
					const allowed = JUDGMENT_VALUES[c.judge] as
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
				case "entryChange":
					if (g === "buy") {
						err(at, "買値からの % は売りの条件だけで使える");
					} else if (!isNumIn(c.percent, LIMITS.percent)) {
						err(`${at}.percent`, `${range(LIMITS.percent)} の範囲で入れる`);
					}
					break;
			}
		});
	}
	if (p.buy.conditions.length === 0) {
		err("buy", "買い注文の条件を1つ以上追加する");
	}
	if (p.buyOrder.type === "limit") {
		const below = p.buyOrder.belowPercent;
		const r = LIMITS.buyBelowPercent;
		if (
			!Number.isFinite(below) ||
			below < r.min ||
			below >= r.maxExclusive ||
			// 0.01% 刻み（ppm の整数に丸めても値が変わらない）
			Math.abs(below * 100 - Math.round(below * 100)) > 1e-9
		) {
			err(
				"buyOrder.belowPercent",
				`${r.min} 以上 ${r.maxExclusive} 未満、0.01 刻みで入れる`,
			);
		}
		if (!isIntIn(p.buyOrder.expireBars, LIMITS.buyExpireBars)) {
			const e = LIMITS.buyExpireBars;
			err("buyOrder.expireBars", `${e.min}〜${e.max} の整数で入れる`);
		}
	}
	if (p.stopLoss.conditions.length === 0) {
		err(
			"stopLoss",
			"損切りの条件がないと、下がり続けても売らない。1つ以上追加する",
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

export function evaluateConditionSet(
	input: StrategyInput<ConditionSet>,
): StrategyOutput {
	const {
		now,
		candles,
		judgments,
		position,
		cash,
		openOrders,
		params: p,
		state,
	} = input;
	const holding = position.quantity > 0;
	const done = (note: string, intents: OrderIntent[] = []): StrategyOutput => ({
		intents,
		nextEvalAt: nextEval(now, p, holding),
		state,
		note,
	});

	const last = candles.at(-1);
	if (!last) {
		return done("足が無いため判定しない");
	}
	if (openOrders.some((o) => o.side === (holding ? "sell" : "buy"))) {
		return done(holding ? "売り注文の約定待ち" : "買い注文の約定待ち");
	}
	const ctx: Ctx = {
		candles,
		closes: candles.map((c) => c.close),
		price: last.close,
		entryPrice: position.entryPrice,
		emaCache: new Map(),
		judgments: latestJudgments(judgments),
	};

	if (!holding) {
		const r = evaluateGroup(p.buy, ctx);
		if (r.kind === "insufficient") {
			return done(`指標の本数が足りないため判定しない（${r.why}）`);
		}
		if (r.kind === "miss") {
			return done("買いの条件を満たさない");
		}
		const order = p.buyOrder;
		if (order.type === "market") {
			// 約定価格は発注後に決まるので、判定時の現在値で見積もる
			const cost = notionalYen(ctx.price, p.orderSize, "ceil");
			if (cash < cost) {
				return done(
					`${r.why}資金 ${formatYen(cash)} 円が注文額の見積もり ${formatYen(cost)} 円に足りないため買わない`,
				);
			}
			return done(`${r.why}成行で ${formatBtc(p.orderSize)} BTC を買い`, [
				{
					kind: "place",
					side: "buy",
					type: "market",
					quantity: p.orderSize,
				},
			]);
		}
		const price = limitBuyPriceBelow(
			ctx.price,
			Math.round(order.belowPercent * 10_000),
		);
		const cost = notionalYen(price, p.orderSize, "ceil");
		if (cash < cost) {
			return done(
				`${r.why}資金 ${formatYen(cash)} 円が注文額 ${formatYen(cost)} 円に足りないため買わない`,
			);
		}
		return done(
			`${r.why}現在値 ${formatYen(ctx.price)} より ${order.belowPercent}% 下の ${formatYen(price)} に指値で ${formatBtc(p.orderSize)} BTC を買い（${order.expireBars} 本のあいだ約定しなければ取消）`,
			[
				{
					kind: "place",
					side: "buy",
					type: "limit",
					price,
					quantity: p.orderSize,
					expireAfterBars: order.expireBars,
				},
			],
		);
	}

	// 同じ判定で両方成立したら損切りを優先する（損失を小さく見積もらないため）
	const sl = evaluateGroup(p.stopLoss, ctx);
	const tp = evaluateGroup(p.takeProfit, ctx);
	for (const r of [sl, tp]) {
		if (r.kind === "insufficient") {
			return done(`指標の本数が足りないため判定しない（${r.why}）`);
		}
	}
	const hit =
		sl.kind === "hit"
			? { why: sl.why, label: "損切り" }
			: tp.kind === "hit"
				? { why: tp.why, label: "利確" }
				: null;
	if (!hit) {
		return done("売りの条件を満たさない");
	}
	return done(
		`${hit.why}保有中の ${formatBtc(position.quantity)} BTC を売却（${hit.label}の条件）`,
		[
			{
				kind: "place",
				side: "sell",
				type: "market",
				quantity: position.quantity,
			},
		],
	);
}

export const conditionStrategy: Strategy<ConditionSet> = {
	id: "condition",
	requiredJudges,
	minResolution: (p) => p.timeframe,
	historyBars,
	validate: validateConditionSet,
	evaluate: evaluateConditionSet,
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
				values: v.values as JudgmentValue[],
			};
		case "entryChange":
			if (v.direction !== "up" && v.direction !== "down") return null;
			return {
				type: "entryChange",
				percent: num(v.percent),
				direction: v.direction,
			};
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

/** 無ければ既定の出し方（保存済みの戦略が持っていない） */
function parseBuyOrder(v: unknown): BuyOrder | null {
	if (v === undefined) return { ...DEFAULT_BUY_ORDER };
	if (!isObj(v) || (v.type !== "limit" && v.type !== "market")) return null;
	const num = (x: unknown) => (typeof x === "number" ? x : Number.NaN);
	return {
		type: v.type,
		belowPercent: num(v.belowPercent),
		expireBars: num(v.expireBars),
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
		buy,
		buyOrder,
		takeProfit,
		stopLoss,
	};
}
