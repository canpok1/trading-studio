// 売買の1ステップ。バックテストとペーパー（のちにライブ）で同じ関数を使い、同じ戦略がどのモードでも同じ動きをするようにする。
// 1ステップは「約定の反映 → 期限切れの指値の取消 → 戦略の評価 → 注文の作成」。約定の判定（足か約定データか）だけ呼び出し側が差し替える

import { formatBtc, formatYen } from "./format";
import { feeYen, notionalYen } from "./money";
import type { Strategy, StrategyOutput } from "./strategy";
import type {
	Candle,
	JsonValue,
	Judgment,
	Order,
	OrderIntent,
	OrderType,
	Position,
	Side,
} from "./types";
import { EMPTY_POSITION } from "./types";

/** 手数料率（ppm） */
export type FeeRates = { limitPpm: number; marketPpm: number };

/** 既定の手数料率。どちらも 0.1%（Coincheck の実際の率は未確認の仮置き） */
export const DEFAULT_FEE_RATES: FeeRates = { limitPpm: 1000, marketPpm: 1000 };

/** 注文の記録。発注から約定・取消までを1件で持つ */
export type TradeOrder = {
	id: string;
	side: Side;
	type: OrderType;
	/** 指値の価格。成行は null */
	price: number | null;
	quantity: number;
	placedAt: number;
	status: "open" | "filled" | "canceled";
	filledAt: number | null;
	fillPrice: number | null;
	fee: number | null;
	canceledAt: number | null;
	cancelReason: string | null;
	/** 発注した判断の理由 */
	reason: string;
	/** 対応する買い / 売りの注文 */
	pairId: string | null;
	/** 売りの約定で確定した往復の損益（手数料込み） */
	pnl: number | null;
};

/** 判断の記録。評価のたびに1件 */
export type DecisionLog = {
	time: number;
	/** 判定時の現在値 */
	price: number;
	cash: number;
	position: Position;
	openOrderIds: string[];
	intents: OrderIntent[];
	nextEvalAt: number;
	note: string | null;
	state: JsonValue;
};

/** 往復の取引 */
export type Trade = {
	buyOrderId: string;
	sellOrderId: string;
	entryTime: number;
	exitTime: number;
	quantity: number;
	/** 手数料込みの損益 */
	pnl: number;
};

/** 未約定の注文。戦略へ渡す注文（期限つき）と記録の組 */
export type OpenOrder = { order: Order; record: TradeOrder };

/** 口座。現金・保有・未約定の注文と、往復の損益を出すための買いの支払い */
export type Account = {
	cash: number;
	position: Position;
	/** 保有中のポジションの買いの記録と、その支払い（手数料込み）。売りで往復が閉じたら買いの記録にも対応づける */
	entry: { record: TradeOrder; time: number; cost: number } | null;
	openOrders: OpenOrder[];
	/** 注文の通し番号。注文の id に使う */
	seq: number;
};

export function newAccount(cash: number, seq = 0): Account {
	return { cash, position: EMPTY_POSITION, entry: null, openOrders: [], seq };
}

/** 1ステップで変わったもの。changed は発注・約定・取消・対応づけで変わった注文の記録（最新の内容） */
export type StepChanges = {
	changed: TradeOrder[];
	trades: Trade[];
};

const feeRate = (fees: FeeRates, type: OrderType) =>
	type === "limit" ? fees.limitPpm : fees.marketPpm;

function withChanged(list: TradeOrder[], record: TradeOrder): void {
	const i = list.findIndex((r) => r.id === record.id);
	if (i >= 0) list[i] = record;
	else list.push(record);
}

function cancelRecord(
	record: TradeOrder,
	time: number,
	reason: string,
): TradeOrder {
	return {
		...record,
		status: "canceled",
		canceledAt: time,
		cancelReason: reason,
	};
}

/**
 * 約定の反映。fillPrice が未約定の注文ごとに約定価格（約定しなければ null）を返す。
 * 成行の買いは約定価格が発注後に決まるため、約定の時点で手数料込みの額が現金に足りなければ取り消す（全モード共通）
 */
export function settleFills(
	account: Account,
	fillPrice: (order: Order) => number | null,
	time: number,
	fees: FeeRates,
): StepChanges & { account: Account; filled: boolean } {
	let { cash, position, entry } = account;
	const changed: TradeOrder[] = [];
	const trades: Trade[] = [];
	const remaining: OpenOrder[] = [];
	let filled = false;
	for (const item of account.openOrders) {
		const { order } = item;
		const price = fillPrice(order);
		if (price === null) {
			remaining.push(item);
			continue;
		}
		const fee = feeYen(price, order.quantity, feeRate(fees, order.type));
		if (order.side === "buy") {
			const cost = notionalYen(price, order.quantity, "ceil");
			if (order.type === "market" && cash < cost + fee) {
				withChanged(
					changed,
					cancelRecord(
						item.record,
						time,
						`資金 ${formatYen(cash)} 円が手数料込みの約定額 ${formatYen(cost + fee)} 円に足りないため取消`,
					),
				);
				continue;
			}
			cash -= cost + fee;
			// ポジションは1つだけ持つが、買い増しが起きても平均の買値を保つ
			const qty = position.quantity + order.quantity;
			const entryPrice =
				position.entryPrice === null
					? price
					: (position.entryPrice * position.quantity + price * order.quantity) /
						qty;
			position = {
				quantity: qty,
				entryPrice,
				openedAt: position.openedAt ?? time,
			};
			const record: TradeOrder = {
				...item.record,
				status: "filled",
				filledAt: time,
				fillPrice: price,
				fee,
			};
			entry = entry
				? { ...entry, cost: entry.cost + cost + fee }
				: { record, time, cost: cost + fee };
			withChanged(changed, record);
		} else {
			const proceeds = notionalYen(price, order.quantity, "floor");
			cash += proceeds - fee;
			const qty = position.quantity - order.quantity;
			position = qty > 0 ? { ...position, quantity: qty } : EMPTY_POSITION;
			let record: TradeOrder = {
				...item.record,
				status: "filled",
				filledAt: time,
				fillPrice: price,
				fee,
			};
			if (qty === 0 && entry) {
				// 往復の損益は、売りの受け取り − 買いの支払い（どちらも手数料込み）
				const pnl = proceeds - fee - entry.cost;
				trades.push({
					buyOrderId: entry.record.id,
					sellOrderId: order.id,
					entryTime: entry.time,
					exitTime: time,
					quantity: order.quantity,
					pnl,
				});
				record = { ...record, pnl, pairId: entry.record.id };
				withChanged(changed, { ...entry.record, pairId: order.id });
				entry = null;
			}
			withChanged(changed, record);
		}
		filled = true;
	}
	return {
		account: { ...account, cash, position, entry, openOrders: remaining },
		changed,
		trades,
		filled,
	};
}

/** 期限切れの指値の取消。期限（発注時刻 + 戦略の粒度の足 M 本ぶんの時間）が now 以前の注文を取り消す */
export function expireOrders(
	account: Account,
	now: number,
	timeframeMs: number,
): { account: Account; changed: TradeOrder[] } {
	const changed: TradeOrder[] = [];
	const remaining: OpenOrder[] = [];
	for (const item of account.openOrders) {
		const exp = item.order.expiresAt;
		if (exp !== null && now >= exp) {
			const bars = Math.round((exp - item.order.placedAt) / timeframeMs);
			changed.push(
				cancelRecord(
					item.record,
					now,
					`指値 ${formatYen(item.order.price ?? 0)} が ${bars} 本のあいだ約定しなかったため取消`,
				),
			);
		} else {
			remaining.push(item);
		}
	}
	return { account: { ...account, openOrders: remaining }, changed };
}

/** 未約定の注文をすべて取り消す（期間の終わり・リセットなど） */
export function cancelAll(
	account: Account,
	time: number,
	reason: string,
): { account: Account; changed: TradeOrder[] } {
	return {
		account: { ...account, openOrders: [] },
		changed: account.openOrders.map((x) =>
			cancelRecord(x.record, time, reason),
		),
	};
}

export type DecideInput<P> = {
	strategy: Strategy<P>;
	params: P;
	/** 評価時刻 */
	now: number;
	/** 判定時の現在値 */
	price: number;
	/** 戦略の粒度の足（古い順）。最後は途中の足でもよい */
	candles: readonly Candle[];
	/** 判定器ごとの AI 判定。評価時点で今の集計ルールで計算したもの */
	judgments: Readonly<Record<string, readonly Judgment[]>>;
	account: Account;
	state: JsonValue;
	fees: FeeRates;
	/** 戦略の粒度の足1本の長さ。指値の取消までの本数を時間に直すのに使う */
	timeframeMs: number;
	/** 注文の id の頭につける文字。既定は "o" */
	idPrefix?: string;
	/**
	 * 新しい買いを止める理由（リスク上限など）。null なら止めない。
	 * 戦略の条件とは別に、注文を出す手前で検査する。売りは止めない
	 */
	blockBuy?: string | null;
};

export type DecideOutput = StepChanges & {
	account: Account;
	state: JsonValue;
	nextEvalAt: number;
	decision: DecisionLog;
};

/** 戦略の評価と注文の作成 */
export function decide<P>(input: DecideInput<P>): DecideOutput {
	const { strategy, params, now, fees, timeframeMs } = input;
	const prefix = input.idPrefix ?? "o";
	let { cash, position, seq } = input.account;
	let open = [...input.account.openOrders];
	const changed: TradeOrder[] = [];
	const openOrders = open.map((x) => ({ ...x.order }));

	const out: StrategyOutput = strategy.evaluate({
		now,
		candles: input.candles,
		judgments: input.judgments,
		position,
		cash,
		openOrders,
		params,
		state: input.state,
	});

	const place = (
		intent: Extract<OrderIntent, { kind: "place" }>,
		reason: string,
	): string | null => {
		if (intent.type === "limit" && intent.price === undefined) {
			return "指値の価格が無いため発注しない";
		}
		if (intent.side === "buy" && input.blockBuy) {
			return input.blockBuy;
		}
		if (intent.side === "buy" && intent.type === "limit") {
			const price = intent.price as number;
			const need =
				notionalYen(price, intent.quantity, "ceil") +
				feeYen(price, intent.quantity, fees.limitPpm);
			if (cash < need) {
				return `資金 ${formatYen(cash)} 円が手数料込みの注文額 ${formatYen(need)} 円に足りないため発注しない`;
			}
		}
		if (intent.side === "sell" && intent.quantity > position.quantity) {
			return `保有 ${formatBtc(position.quantity)} BTC より多くは売れないため発注しない`;
		}
		seq++;
		const order: Order = {
			id: `${prefix}${seq}`,
			side: intent.side,
			type: intent.type,
			price: intent.type === "limit" ? (intent.price as number) : null,
			quantity: intent.quantity,
			placedAt: now,
			expiresAt:
				intent.expireAfterBars === undefined
					? null
					: now + intent.expireAfterBars * timeframeMs,
			status: "open",
		};
		const record: TradeOrder = {
			id: order.id,
			side: order.side,
			type: order.type,
			price: order.price,
			quantity: order.quantity,
			placedAt: now,
			status: "open",
			filledAt: null,
			fillPrice: null,
			fee: null,
			canceledAt: null,
			cancelReason: null,
			reason,
			pairId: null,
			pnl: null,
		};
		changed.push(record);
		open.push({ order, record });
		return null;
	};

	const notes: string[] = out.note ? [out.note] : [];
	for (const intent of out.intents) {
		if (intent.kind === "place") {
			const rejected = place(intent, out.note ?? "");
			if (rejected) notes.push(rejected);
		} else {
			const item = open.find((x) => x.order.id === intent.orderId);
			if (item) {
				withChanged(
					changed,
					cancelRecord(item.record, now, intent.reason ?? "戦略が取消"),
				);
				open = open.filter((x) => x !== item);
			}
		}
	}
	// 発注した直後に取り消した注文の記録を最新にする
	open = open.map((x) => ({
		...x,
		record: changed.find((r) => r.id === x.record.id) ?? x.record,
	}));

	return {
		account: { ...input.account, cash, position, seq, openOrders: open },
		changed,
		trades: [],
		state: out.state,
		nextEvalAt: out.nextEvalAt,
		decision: {
			time: now,
			price: input.price,
			cash,
			position,
			openOrderIds: openOrders.map((o) => o.id),
			intents: out.intents,
			nextEvalAt: out.nextEvalAt,
			note: notes.length ? notes.join("。") : null,
			state: out.state,
		},
	};
}

export type StepInput<P> = Omit<DecideInput<P>, "candles" | "judgments"> & {
	/** 前回のステップからの約定の判定。time は約定の時刻 */
	fill: { price: (order: Order) => number | null; time: number };
	/** 次の判定時刻。これを過ぎているか、約定があれば評価する */
	nextEvalAt: number;
	/** 評価するときだけ呼ぶ。足と判定を作るのが重いため */
	inputs: () => {
		candles: readonly Candle[];
		judgments: Readonly<Record<string, readonly Judgment[]>>;
	};
};

export type StepOutput = StepChanges & {
	account: Account;
	state: JsonValue;
	nextEvalAt: number;
	/** 評価しなかったステップでは null */
	decision: DecisionLog | null;
};

/** 1回分の売買。約定の反映 → 期限切れの指値の取消 → （判定時刻を過ぎたか約定があれば）戦略の評価と注文の作成 */
export function tradingStep<P>(input: StepInput<P>): StepOutput {
	const settled = settleFills(
		input.account,
		input.fill.price,
		input.fill.time,
		input.fees,
	);
	const expired = expireOrders(settled.account, input.now, input.timeframeMs);
	const changed = [...settled.changed];
	for (const r of expired.changed) withChanged(changed, r);
	if (!settled.filled && input.now < input.nextEvalAt) {
		return {
			account: expired.account,
			changed,
			trades: settled.trades,
			state: input.state,
			nextEvalAt: input.nextEvalAt,
			decision: null,
		};
	}
	const decided = decide({
		...input,
		...input.inputs(),
		account: expired.account,
	});
	for (const r of decided.changed) withChanged(changed, r);
	return {
		account: decided.account,
		changed,
		trades: settled.trades,
		state: decided.state,
		nextEvalAt: decided.nextEvalAt,
		decision: decided.decision,
	};
}

/**
 * 約定データでの約定の判定（ペーパー）。成行は注文後に最初に成立した売買の価格、
 * 指値は指値を跨ぐ売買が成立したら指値で約定する。数量は見ない
 */
export function tradeFillPrice(
	order: Order,
	tradePrice: number,
): number | null {
	if (order.type === "market") return tradePrice;
	const price = order.price as number;
	if (order.side === "buy") return tradePrice <= price ? price : null;
	return tradePrice >= price ? price : null;
}
