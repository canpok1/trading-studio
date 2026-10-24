// 売買の1ステップ。バックテストとデモ（のちにリアル）で同じ関数を使い、同じ戦略がどのモードでも同じ動きをするようにする。
// 1ステップは「約定の反映 → 期限切れの指値の取消 → 戦略の評価 → 注文の作成」。約定の判定（足か約定データか）だけ呼び出し側が差し替える

import type { EventCalendar } from "./event-calendar";
import { formatDuration, formatQuantity, formatYen } from "./format";
import type { Instrument } from "./instrument";
import { marketOf } from "./instrument";
import { feeAmount, notional } from "./money";
import type { Strategy, StrategyInput, StrategyOutput } from "./strategy";
import type { TradingCalendar } from "./trading-calendar";
import { addOpenTime, isOpen, nextOpen } from "./trading-calendar";
import type {
	ExitKind,
	JsonValue,
	Judgment,
	Lot,
	Order,
	OrderIntent,
	OrderType,
	Position,
	Side,
} from "./types";
import { EMPTY_POSITION } from "./types";

/** 手数料率（ppm） */
export type FeeRates = { limitPpm: number; marketPpm: number };

/** 既定の手数料率。Coincheck の取引所の BTC/JPY に合わせてどちらも 0%（https://coincheck.com/ja/exchange/fee） */
export const DEFAULT_FEE_RATES: FeeRates = { limitPpm: 0, marketPpm: 0 };

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
	/** 対応する買い / 売りの注文。売りは発注時から売るロット（買いの注文）を指す。買いは売りが約定したら持つ */
	pairId: string | null;
	/** 売りの約定で確定した往復の損益（手数料込み） */
	pnl: number | null;
	/** 売りを出した条件のグループ。買いは null。記録を足す前の注文には無い（inferExitKind で理由から読む） */
	exitKind?: ExitKind | null;
	/** 買いを出した買いの名前。売りと、買いが1つの戦略の買いは null */
	buyName?: string | null;
};

/**
 * 売りに、売るロット（対応する買い）の約定価格を lotPrice として、売りを出した条件のグループを exitKind として添える。
 * 買いと、ロットが分からない売りの lotPrice は null。exitKind は inferExitKind のとおり
 */
export function withSellDetails<T extends TradeOrder>(
	orders: readonly T[],
): (T & { lotPrice: number | null; exitKind: ExitKind | null })[] {
	const price = new Map(orders.map((o) => [o.id, o.fillPrice]));
	return orders.map((o) => {
		const lotPrice =
			o.side === "sell" && o.pairId ? (price.get(o.pairId) ?? null) : null;
		return { ...o, lotPrice, exitKind: inferExitKind(o, lotPrice) };
	});
}

/** 判断の理由のうち、ロットの売却を述べる文（「…を売却（損切りの条件）」） */
const SELL_SENTENCE = /を売却（(損切り|一部利確|利確)の条件）$/;

/**
 * 判断の理由から、この売りの部分を文の配列で取り出す。成り立った条件の文が続き、最後が売却の文。
 * 1回の判断で複数のロットを売った理由は、売るロットの買値（lotPrice）で自分の部分を選ぶ。1つに決まらなければ null
 */
export function sellReasonPart(
	reason: string,
	lotPrice: number | null,
): string[] | null {
	const parts: string[][] = [];
	let current: string[] = [];
	for (const s of reason.split("。")) {
		current.push(s);
		if (SELL_SENTENCE.test(s)) {
			parts.push(current);
			current = [];
		}
	}
	const mine =
		parts.length === 1 || lotPrice === null
			? parts
			: parts.filter((p) =>
					p.at(-1)?.includes(`買値 ${formatYen(lotPrice)} のロット`),
				);
	return mine.length === 1 ? (mine[0] as string[]) : null;
}

/** 売りを出した条件のグループ。記録があればそれを、記録の無い過去の注文は判断の理由（sellReasonPart）から読む。読めなければ null */
export function inferExitKind(
	order: Pick<TradeOrder, "side" | "reason" | "exitKind">,
	lotPrice: number | null,
): ExitKind | null {
	if (order.side !== "sell") return null;
	if (order.exitKind != null) return order.exitKind;
	const last = sellReasonPart(order.reason, lotPrice)?.at(-1);
	if (last === undefined) return null;
	if (last.endsWith("（損切りの条件）")) return "stopLoss";
	return last.endsWith("（一部利確の条件）")
		? "partialTakeProfit"
		: "takeProfit";
}

/** 判断の記録。評価のたびに1件 */
export type DecisionLog = {
	time: number;
	/** 判定した銘柄の id。銘柄を持つ前の記録には無い */
	instrument?: string;
	/** 判定時の現在値 */
	price: number;
	cash: number;
	position: Position;
	/** 判定時に持っていたロット。ロットを持つ前の記録には無い */
	lots?: Lot[];
	openOrderIds: string[];
	intents: OrderIntent[];
	nextEvalAt: number;
	note: string | null;
	state: JsonValue;
};

/** 往復の取引。ロット1件の買いから最後の売りまでで1件（一部利確の売りは含めて1件にまとめる） */
export type Trade = {
	buyOrderId: string;
	sellOrderId: string;
	entryTime: number;
	/** 最後の売りの約定時刻 */
	exitTime: number;
	/** 買いの数量 */
	quantity: number;
	/** 手数料込みの損益。一部利確の売りの損益を含む */
	pnl: number;
};

/** 未約定の注文。戦略へ渡す注文（期限つき）と記録の組 */
export type OpenOrder = { order: Order; record: TradeOrder };

/** 口座のロット。往復の損益を出すため、買いの記録と支払い（手数料込み）も持つ */
export type AccountLot = Lot & {
	/** 買いの支払い（手数料込み）。一部利確の後は残りの量のぶん */
	cost: number;
	/** 一部利確の売りで確定した損益（手数料込み）。最後の売りで往復の損益に足す */
	realizedPnl?: number;
	/** 買いの記録。売りで往復が閉じたら売りの注文と対応づける */
	record: TradeOrder;
};

/** 自動取引の上限。サーバーの検証と画面で共有する */
export const TRADING_LIMITS = {
	/** 同時に稼働できる戦略の数 */
	running: 5,
} as const;

/** 口座。現金・保有（ロット）・未約定の注文 */
export type Account = {
	cash: number;
	/** 全ロットの合計。lots から作る */
	position: Position;
	/** 保有中のロット（買いの約定順） */
	lots: AccountLot[];
	openOrders: OpenOrder[];
	/** 注文の通し番号。注文の id に使う */
	seq: number;
	/** その日（市場の日の区切り）に確定した損益（手数料込み）。dayStart はその日の始まり */
	today: { dayStart: number; pnl: number };
};

export function newAccount(cash: number, seq = 0): Account {
	return {
		cash,
		position: EMPTY_POSITION,
		lots: [],
		openOrders: [],
		seq,
		today: { dayStart: 0, pnl: 0 },
	};
}

/** ロットの合計。平均の買値は数量で重み付けする */
export function positionOfLots(lots: readonly Lot[]): Position {
	if (lots.length === 0) return EMPTY_POSITION;
	const quantity = lots.reduce((a, l) => a + l.quantity, 0);
	return {
		quantity,
		entryPrice:
			lots.reduce((a, l) => a + l.entryPrice * l.quantity, 0) / quantity,
		openedAt: Math.min(...lots.map((l) => l.openedAt)),
	};
}

/** 戦略へ渡すロット（支払いと記録を除く） */
export const publicLots = (lots: readonly AccountLot[]): Lot[] =>
	lots.map(
		({ id, quantity, entryPrice, openedAt, partialExitDone, buyId }) => ({
			id,
			quantity,
			entryPrice,
			openedAt,
			partialExitDone: partialExitDone ?? false,
			buyId: buyId ?? null,
		}),
	);

type LegacyAccount = Partial<Account> & {
	/** ロットを持つ前の口座の保有（1ポジション） */
	entry?: { record: TradeOrder; time: number; cost: number } | null;
};

/**
 * 保存済みの口座を今の形で読む。ロットを持つ前の口座は、保有を1ロットとして読み、
 * 売るロットを持たない売りの注文はそのロットの売りとする。1日の確定損益を持つ前の口座も読める
 */
export function normalizeAccount(raw: LegacyAccount): Account {
	const { entry, ...rest } = raw;
	const position = raw.position ?? EMPTY_POSITION;
	let lots = raw.lots;
	if (!lots) {
		lots =
			entry && position.quantity > 0
				? [
						{
							id: entry.record.id,
							quantity: position.quantity,
							entryPrice: position.entryPrice ?? entry.record.fillPrice ?? 0,
							openedAt: position.openedAt ?? entry.time,
							cost: entry.cost,
							record: entry.record,
						},
					]
				: [];
	}
	const only = lots.length === 1 ? (lots[0] as AccountLot).id : null;
	return {
		cash: 0,
		seq: 0,
		today: { dayStart: 0, pnl: 0 },
		...rest,
		position: positionOfLots(lots),
		lots,
		openOrders: (raw.openOrders ?? []).map((x) =>
			x.order.side === "sell" && !x.order.lotId && only
				? { ...x, order: { ...x.order, lotId: only } }
				: x,
		),
	};
}

/** その時刻の日（市場の日の区切り）に確定した損益。前の日の分は数えない */
export function realizedPnlOn(
	account: Account,
	time: number,
	calendar: TradingCalendar,
): number {
	return account.today.dayStart === calendar.dayStart(time)
		? account.today.pnl
		: 0;
}

/** 1日の損失上限で新しい買いを止める理由。止めなければ null */
export function dailyLossBlock(
	account: Account,
	time: number,
	limit: number | null,
	calendar: TradingCalendar,
): string | null {
	if (limit === null) return null;
	const loss = -realizedPnlOn(account, time, calendar);
	return loss >= limit
		? `本日の確定損失 ${formatYen(loss)} 円が1日の損失上限 ${formatYen(limit)} 円に達したため買わない（翌 0 時に再開）`
		: null;
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
 * ほかの銘柄の注文はそのまま残す（銘柄を持たない注文はこの銘柄として扱う）。
 * 成行の買いは約定価格が発注後に決まるため、約定の時点で手数料込みの額が現金に足りなければ取り消す（全モード共通）
 */
export function settleFills(
	account: Account,
	fillPrice: (order: Order) => number | null,
	time: number,
	fees: FeeRates,
	instrument: Instrument,
	calendar: TradingCalendar = marketOf(instrument).calendar,
): StepChanges & { account: Account; filled: boolean } {
	let { cash, lots, today } = account;
	const changed: TradeOrder[] = [];
	const trades: Trade[] = [];
	const remaining: OpenOrder[] = [];
	let filled = false;
	// 取引時間外は約定しない
	if (!isOpen(calendar, time)) {
		return { account, changed, trades, filled };
	}
	for (const item of account.openOrders) {
		const { order } = item;
		const price =
			(order.instrument ?? instrument.id) === instrument.id
				? fillPrice(order)
				: null;
		if (price === null) {
			remaining.push(item);
			continue;
		}
		const fee = feeAmount(
			instrument,
			price,
			order.quantity,
			feeRate(fees, order.type),
		);
		if (order.side === "buy") {
			const cost = notional(instrument, price, order.quantity, "ceil");
			// 指値は発注時に資金を確かめているが、同時に出した注文が先に約定して足りなくなることがあるため、約定時にも確かめる
			if (cash < cost + fee) {
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
			const record: TradeOrder = {
				...item.record,
				status: "filled",
				filledAt: time,
				fillPrice: price,
				fee,
			};
			lots = [
				...lots,
				{
					id: order.id,
					quantity: order.quantity,
					entryPrice: price,
					openedAt: time,
					cost: cost + fee,
					record,
					buyId: order.buyId ?? null,
					...(order.instrument ? { instrument: order.instrument } : {}),
				},
			];
			withChanged(changed, record);
		} else {
			const lot = lots.find((l) => l.id === order.lotId);
			if (!lot || order.quantity > lot.quantity) {
				withChanged(
					changed,
					cancelRecord(item.record, time, "売るロットが無いため取消"),
				);
				continue;
			}
			const proceeds = notional(instrument, price, order.quantity, "floor");
			cash += proceeds - fee;
			const partial = order.quantity < lot.quantity;
			// 一部だけ売るときは、買いの支払いを売った量のぶんだけ按分する
			const cost = partial
				? Math.round((lot.cost * order.quantity) / lot.quantity)
				: lot.cost;
			// 売りの損益は、売りの受け取り − 買いの支払い（どちらも手数料込み）
			const pnl = proceeds - fee - cost;
			if (partial) {
				lots = lots.map((l) =>
					l === lot
						? {
								...l,
								quantity: l.quantity - order.quantity,
								cost: l.cost - cost,
								realizedPnl: (l.realizedPnl ?? 0) + pnl,
								partialExitDone: true,
							}
						: l,
				);
			} else {
				lots = lots.filter((l) => l !== lot);
				trades.push({
					buyOrderId: lot.id,
					sellOrderId: order.id,
					entryTime: lot.openedAt,
					exitTime: time,
					quantity: lot.record.quantity,
					pnl: pnl + (lot.realizedPnl ?? 0),
				});
			}
			const day = calendar.dayStart(time);
			today = {
				dayStart: day,
				pnl: (today.dayStart === day ? today.pnl : 0) + pnl,
			};
			// 買いの記録は、ロットを閉じた売りと対応づける
			if (!partial) withChanged(changed, { ...lot.record, pairId: order.id });
			withChanged(changed, {
				...item.record,
				status: "filled",
				filledAt: time,
				fillPrice: price,
				fee,
				pnl,
				pairId: lot.id,
			});
		}
		filled = true;
	}
	return {
		account: {
			...account,
			cash,
			position: positionOfLots(lots),
			lots,
			today,
			openOrders: remaining,
		},
		changed,
		trades,
		filled,
	};
}

/** 期限切れの指値の取消。期限（発注時刻 + 戦略が決めた時間）が now 以前の注文を取り消す */
export function expireOrders(
	account: Account,
	now: number,
): { account: Account; changed: TradeOrder[] } {
	const changed: TradeOrder[] = [];
	const remaining: OpenOrder[] = [];
	for (const item of account.openOrders) {
		const exp = item.order.expiresAt;
		if (exp !== null && now >= exp) {
			changed.push(
				cancelRecord(
					item.record,
					now,
					`指値 ${formatYen(item.order.price ?? 0)} が ${formatDuration(exp - item.order.placedAt)}のあいだ約定しなかったため取消`,
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
	instrument: Instrument;
	strategy: Strategy<P>;
	params: P;
	/** 評価時刻 */
	now: number;
	/** 判定時の現在値 */
	price: number;
	/** 粒度ごとの足（古い順）。最後は途中の足でもよい */
	candles: StrategyInput<P>["candles"];
	/** 直近の細かい足 */
	recent: StrategyInput<P>["recent"];
	/** 判定器ごとの AI 判定。評価時点で今の集計ルールで計算したもの */
	judgments: Readonly<Record<string, readonly Judgment[]>>;
	/** 予定の暦 */
	events: EventCalendar;
	/** DVOL の1時間足 */
	dvol: StrategyInput<P>["dvol"];
	account: Account;
	state: JsonValue;
	fees: FeeRates;
	/** 注文の id の頭につける文字。既定は "o" */
	idPrefix?: string;
};

export type DecideOutput = StepChanges & {
	account: Account;
	state: JsonValue;
	nextEvalAt: number;
	decision: DecisionLog;
};

/** 1銘柄ぶんの判定の材料 */
export type MarketInput<P> = Pick<
	DecideInput<P>,
	"instrument" | "price" | "candles" | "recent" | "dvol" | "state"
>;

export type DecideAllInput<P> = Omit<DecideInput<P>, keyof MarketInput<P>> & {
	/** 対象の銘柄（同じ市場）。並び順が資金配分の優先順位で、先の銘柄の買いから資金を割り当てる */
	markets: readonly MarketInput<P>[];
};

/** 銘柄ごとの判定の結果 */
export type MarketDecision = {
	instrument: string;
	state: JsonValue;
	nextEvalAt: number;
	decision: DecisionLog;
};

export type DecideAllOutput = StepChanges & {
	account: Account;
	results: MarketDecision[];
};

/** 口座のロット・注文がその銘柄のものか。銘柄を持たない保存済みのものは先頭の銘柄として読む */
function ofInstrument(
	x: { instrument?: string },
	id: string,
	first: string,
): boolean {
	return (x.instrument ?? first) === id;
}

/** 戦略の評価と注文の作成（1銘柄） */
export function decide<P>(input: DecideInput<P>): DecideOutput {
	const { instrument, price, candles, recent, dvol, state, ...rest } = input;
	const out = decideAll({
		...rest,
		markets: [{ instrument, price, candles, recent, dvol, state }],
	});
	const r = out.results[0] as MarketDecision;
	return {
		account: out.account,
		changed: out.changed,
		trades: out.trades,
		state: r.state,
		nextEvalAt: r.nextEvalAt,
		decision: r.decision,
	};
}

/**
 * 銘柄ごとの売買の判断と資金配分。銘柄ごとに同じ戦略で判定し、出す注文を銘柄の並び順に割り当てる。
 * 買いの資金は、先に割り当てた銘柄の未約定の買いを除いた残りで確かめるので、資金が足りなければ先の銘柄が優先される
 */
export function decideAll<P>(input: DecideAllInput<P>): DecideAllOutput {
	const { strategy, params, now, fees, markets } = input;
	const first = markets[0]?.instrument.id ?? "";
	const prefix = input.idPrefix ?? "o";
	const { cash, lots } = input.account;
	let { seq } = input.account;
	let open = [...input.account.openOrders];
	const changed: TradeOrder[] = [];
	const results: MarketDecision[] = [];

	for (const m of markets) {
		const { instrument } = m;
		const { calendar } = marketOf(instrument);
		const mine = <T extends { instrument?: string }>(x: T) =>
			ofInstrument(x, instrument.id, first);
		const myLots = lots.filter(mine);
		const position = positionOfLots(myLots);
		const openOrders = open
			.filter((x) => mine(x.order))
			.map((x) => ({ ...x.order }));
		// リスク上限は戦略の条件とは別に、注文を出す手前で検査する。止めるのは新しい買いだけ
		const blockBuy = dailyLossBlock(
			input.account,
			now,
			strategy.dailyLossLimit?.(params) ?? null,
			calendar,
		);

		const out: StrategyOutput = strategy.evaluate({
			instrument,
			now,
			price: m.price,
			candles: m.candles,
			recent: m.recent,
			judgments: input.judgments,
			events: input.events,
			dvol: m.dvol,
			position,
			lots: publicLots(myLots),
			cash,
			openOrders,
			params,
			state: m.state,
		});

		// 未約定の買いが約定したときに払う額（手数料込み）。同時に出した買いが全部約定しても現金が足りるようにする。
		// 成行は判定時の現在値で見積もる。ほかの銘柄の買いはその銘柄の価格と単位で見積もる
		const priceOf = (id: string) =>
			markets.find((x) => x.instrument.id === id) ?? m;
		const buyNeed = (o: {
			type: OrderType;
			price?: number | null;
			quantity: number;
			instrument?: string;
		}) => {
			const at = priceOf(o.instrument ?? first);
			const inst = at.instrument;
			const p = o.type === "limit" ? (o.price as number) : at.price;
			return (
				notional(inst, p, o.quantity, "ceil") +
				feeAmount(inst, p, o.quantity, feeRate(fees, o.type))
			);
		};

		const place = (
			intent: Extract<OrderIntent, { kind: "place" }>,
			reason: string,
		): string | null => {
			if (intent.type === "limit" && intent.price === undefined) {
				return "指値の価格が無いため注文しない";
			}
			if (intent.side === "buy" && blockBuy) {
				return blockBuy;
			}
			if (intent.side === "buy") {
				const reserved = open
					.filter((x) => x.order.side === "buy")
					.reduce((a, x) => a + buyNeed(x.order), 0);
				const need = buyNeed({ ...intent, instrument: instrument.id });
				// 成行は約定時に確かめる（1件だけなら今までどおり発注する）
				if (
					(intent.type === "limit" || reserved > 0) &&
					cash - reserved < need
				) {
					return reserved > 0
						? `資金 ${formatYen(cash)} 円から未約定の買い ${formatYen(reserved)} 円を除くと、手数料込みの注文額 ${formatYen(need)} 円に足りないため注文しない`
						: `資金 ${formatYen(cash)} 円が手数料込みの注文額 ${formatYen(need)} 円に足りないため注文しない`;
				}
			}
			if (intent.side === "sell") {
				const lot = myLots.find((l) => l.id === intent.lotId);
				if (!lot) {
					return "売るロットが無いため注文しない";
				}
				if (intent.quantity <= 0 || intent.quantity > lot.quantity) {
					return `ロットの ${formatQuantity(instrument, lot.quantity)} ${instrument.quantityUnit} を超える数量は売れないため注文しない`;
				}
				if (open.some((x) => x.order.lotId === lot.id)) {
					return "このロットの売りが約定待ちのため注文しない";
				}
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
					intent.expireAfterMs === undefined
						? null
						: addOpenTime(calendar, now, intent.expireAfterMs),
				status: "open",
				lotId: intent.side === "sell" ? (intent.lotId ?? null) : null,
				buyId: intent.side === "buy" ? (intent.buyId ?? null) : null,
				...(markets.length > 1 ? { instrument: instrument.id } : {}),
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
				// 売りは売るロット（買いの注文）と対応づける
				pairId: order.lotId ?? null,
				pnl: null,
				exitKind: intent.side === "sell" ? (intent.exitKind ?? null) : null,
				buyName: intent.side === "buy" ? (intent.buyName ?? null) : null,
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
				const item = open.find(
					(x) => x.order.id === intent.orderId && mine(x.order),
				);
				if (item) {
					withChanged(
						changed,
						cancelRecord(item.record, now, intent.reason ?? "戦略が取消"),
					);
					open = open.filter((x) => x !== item);
				}
			}
		}

		// 取引時間外は判定しない。次の判定は次の立会まで送る
		const nextEvalAt = nextOpen(calendar, out.nextEvalAt);
		results.push({
			instrument: instrument.id,
			state: out.state,
			nextEvalAt,
			decision: {
				time: now,
				...(markets.length > 1 ? { instrument: instrument.id } : {}),
				price: m.price,
				cash,
				position,
				lots: publicLots(myLots),
				openOrderIds: openOrders.map((o) => o.id),
				intents: out.intents,
				nextEvalAt,
				note: notes.length ? notes.join("。") : null,
				state: out.state,
			},
		});
	}
	// 発注した直後に取り消した注文の記録を最新にする
	open = open.map((x) => ({
		...x,
		record: changed.find((r) => r.id === x.record.id) ?? x.record,
	}));

	return {
		account: { ...input.account, seq, openOrders: open },
		changed,
		trades: [],
		results,
	};
}

export type StepInput<P> = Omit<
	DecideInput<P>,
	"candles" | "recent" | "judgments" | "dvol"
> & {
	/** 前回のステップからの約定の判定。time は約定の時刻 */
	fill: { price: (order: Order) => number | null; time: number };
	/** 次の判定時刻。これを過ぎているか、約定があれば評価する */
	nextEvalAt: number;
	/** 評価するときだけ呼ぶ。足と判定を作るのが重いため */
	inputs: () => {
		candles: StrategyInput<P>["candles"];
		recent: StrategyInput<P>["recent"];
		judgments: Readonly<Record<string, readonly Judgment[]>>;
		dvol: StrategyInput<P>["dvol"];
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
		input.instrument,
	);
	const expired = expireOrders(settled.account, input.now);
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
 * 約定データでの約定の判定（デモ）。成行は注文後に最初に成立した売買の価格、
 * 指値は指値を跨ぐ売買が成立したら指値で約定する。数量は見ない。
 * 注文より前に成立した売買（届くのが遅れたもの）では約定しない。取引所の時刻は秒単位なので秒で比べる
 */
export function tradeFillPrice(
	order: Order,
	trade: { time: number; price: number },
): number | null {
	if (trade.time < Math.floor(order.placedAt / 1000) * 1000) return null;
	if (order.type === "market") return trade.price;
	const price = order.price as number;
	if (order.side === "buy") return trade.price <= price ? price : null;
	return trade.price >= price ? price : null;
}

/** リアル取引を動かせるか。フェーズ5で有効にするまでは、ホームで選べず口座・成績・注文を出さない（MCP も同じ） */
export const LIVE_AVAILABLE = false;
