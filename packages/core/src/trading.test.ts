import { describe, expect, test } from "bun:test";
import { defaultFillModel, runBacktest } from "./backtest";
import { conditionStrategy } from "./condition-strategy";
import type { Strategy } from "./strategy";
import { strategyTemplate } from "./templates";
import { TIMEFRAME_MS } from "./timeframe";
import type { Account, StepOutput, TradeOrder } from "./trading";
import {
	decide,
	expireOrders,
	newAccount,
	settleFills,
	tradingStep,
} from "./trading";
import type { Candle, JsonValue, Order } from "./types";

const H = TIMEFRAME_MS["1h"];
const FEES = { limitPpm: 1000, marketPpm: 1000 };

const series = (length: number): Candle[] =>
	Array.from({ length }, (_, i) => {
		const p = 10_000_000 + Math.round(Math.sin(i / 30) * 800_000 + i * 500);
		return {
			time: i * H,
			open: p,
			high: p + 100_000,
			low: p - 100_000,
			close: p,
			volume: 0,
		};
	});

describe("バックテストとの一致", () => {
	test("同じ足を1ステップずつ直接渡すと、バックテストと同じ注文・判断・state になる", () => {
		const params = strategyTemplate("trend").params;
		const candles = series(2000);
		const from = 500 * H;
		const bt = runBacktest({
			strategy: conditionStrategy,
			params,
			candles,
			dataTimeframe: "1m",
			from,
			to: candles.length * H,
			initialCash: 2_000_000,
			fees: FEES,
		});
		expect(bt.summary.trades).toBeGreaterThan(0);

		const history = conditionStrategy.historyBars(params);
		let account: Account = newAccount(2_000_000);
		let state: JsonValue = null;
		let nextEvalAt = Number.NEGATIVE_INFINITY;
		const orders = new Map<string, TradeOrder>();
		const decisions = [];
		for (let i = 500; i < candles.length; i++) {
			const bar = candles[i] as Candle;
			const out: StepOutput = tradingStep({
				strategy: conditionStrategy,
				params,
				now: bar.time + H,
				price: bar.close,
				account,
				state,
				fees: FEES,
				timeframeMs: H,
				nextEvalAt,
				fill: { price: (o) => defaultFillModel(o, bar), time: bar.time },
				inputs: () => ({
					candles: candles.slice(Math.max(0, i - history + 1), i + 1),
					judgments: {},
				}),
			});
			account = out.account;
			state = out.state;
			nextEvalAt = out.nextEvalAt;
			for (const r of out.changed) orders.set(r.id, r);
			if (out.decision) decisions.push(out.decision);
		}
		const open = bt.orders.filter(
			(o) => o.cancelReason === "期間の終わりまで約定しなかった",
		);
		expect([...orders.values()]).toEqual(
			bt.orders.map((o) =>
				open.includes(o)
					? { ...o, status: "open", canceledAt: null, cancelReason: null }
					: o,
			),
		);
		expect(decisions).toEqual(bt.decisions);
	});
});

// 評価のたびに渡された intents を出すだけの戦略
const fixed = (
	intents: ReturnType<Strategy<null>["evaluate"]>["intents"],
): Strategy<null> => ({
	id: "fixed",
	requiredJudges: () => [],
	minResolution: () => "1h",
	historyBars: () => 1,
	validate: () => [],
	evaluate: ({ now, state }) => ({
		intents,
		nextEvalAt: now + H,
		state,
		note: "理由",
	}),
});

const decideWith = (
	strategy: Strategy<null>,
	account: Account,
	blockBuy?: string | null,
) =>
	decide({
		strategy,
		params: null,
		now: 10 * H,
		price: 10_000_000,
		candles: [],
		judgments: {},
		account,
		state: null,
		fees: FEES,
		timeframeMs: H,
		idPrefix: "p",
		blockBuy,
	});

describe("注文の作成と約定", () => {
	const buyLimit = fixed([
		{
			kind: "place",
			side: "buy",
			type: "limit",
			price: 10_000_000,
			quantity: 1_000_000,
			expireAfterBars: 3,
		},
	]);

	test("指値は期限（足 M 本ぶんの時間）つきで出し、約定で現金と保有が変わる", () => {
		const placed = decideWith(buyLimit, newAccount(1_000_000));
		const order = placed.account.openOrders[0]?.order as Order;
		expect(order).toMatchObject({ id: "p1", expiresAt: 13 * H });
		expect(placed.changed[0]).toMatchObject({ status: "open", reason: "理由" });

		const filled = settleFills(placed.account, () => 10_000_000, 11 * H, FEES);
		expect(filled.filled).toBe(true);
		expect(filled.account.cash).toBe(1_000_000 - 100_000 - 100);
		expect(filled.account.position).toEqual({
			quantity: 1_000_000,
			entryPrice: 10_000_000,
			openedAt: 11 * H,
		});
		expect(filled.changed[0]).toMatchObject({
			status: "filled",
			filledAt: 11 * H,
			fee: 100,
		});
	});

	test("期限を過ぎた指値は取り消す", () => {
		const placed = decideWith(buyLimit, newAccount(1_000_000));
		expect(expireOrders(placed.account, 13 * H - 1, H).changed).toEqual([]);
		const out = expireOrders(placed.account, 13 * H, H);
		expect(out.account.openOrders).toEqual([]);
		expect(out.changed[0]).toMatchObject({
			status: "canceled",
			cancelReason: "指値 10,000,000 が 3 本のあいだ約定しなかったため取消",
		});
	});

	test("成行の買いは約定時に手数料込みの額が足りなければ取り消す", () => {
		const market = fixed([
			{ kind: "place", side: "buy", type: "market", quantity: 1_000_000 },
		]);
		const placed = decideWith(market, newAccount(100_000));
		const out = settleFills(placed.account, () => 10_000_000, 11 * H, FEES);
		expect(out.filled).toBe(false);
		expect(out.account.cash).toBe(100_000);
		expect(out.changed[0]).toMatchObject({
			status: "canceled",
			cancelReason:
				"資金 100,000 円が手数料込みの約定額 100,100 円に足りないため取消",
		});
	});

	test("売りで往復が閉じると、損益を出し買いの記録にも対応づける", () => {
		const placed = decideWith(buyLimit, newAccount(1_000_000));
		const bought = settleFills(placed.account, () => 10_000_000, 11 * H, FEES);
		const sell = fixed([
			{ kind: "place", side: "sell", type: "market", quantity: 1_000_000 },
		]);
		const selling = decideWith(sell, bought.account);
		const sold = settleFills(selling.account, () => 11_000_000, 12 * H, FEES);
		expect(sold.trades).toEqual([
			{
				buyOrderId: "p1",
				sellOrderId: "p2",
				entryTime: 11 * H,
				exitTime: 12 * H,
				quantity: 1_000_000,
				pnl: 110_000 - 110 - 100_100,
			},
		]);
		expect(sold.changed.map((r) => [r.id, r.pairId])).toEqual([
			["p1", "p2"],
			["p2", "p1"],
		]);
		expect(sold.account.position.quantity).toBe(0);
		expect(sold.account.entry).toBeNull();
	});

	test("blockBuy があれば買いは出さず理由を残し、売りは出す", () => {
		const both = fixed([
			{ kind: "place", side: "buy", type: "market", quantity: 1 },
			{ kind: "place", side: "sell", type: "market", quantity: 1 },
		]);
		const account = {
			...newAccount(1_000_000),
			position: { quantity: 1, entryPrice: 1, openedAt: 0 },
		};
		const out = decideWith(both, account, "損失上限のため買わない");
		expect(out.changed.map((r) => r.side)).toEqual(["sell"]);
		expect(out.decision.note).toBe("理由。損失上限のため買わない");
	});

	test("同じ入力なら同じ結果になる", () => {
		const run = () => {
			const placed = decideWith(buyLimit, newAccount(1_000_000));
			return settleFills(placed.account, () => 10_000_000, 11 * H, FEES);
		};
		expect(run()).toEqual(run());
	});
});
