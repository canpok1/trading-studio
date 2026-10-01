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
	inferExitKind,
	jstDayStart,
	newAccount,
	normalizeAccount,
	publicLots,
	settleFills,
	tradeFillPrice,
	tradingStep,
	withSellDetails,
} from "./trading";
import type { Candle, ExitKind, JsonValue, Order } from "./types";

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
			candles: { "1h": candles },
			stepCandles: candles,
			stepTimeframe: "1h",
			dataTimeframe: "1m",
			from,
			to: candles.length * H,
			initialCash: 2_000_000,
			fees: FEES,
		});
		expect(bt.summary.trades).toBeGreaterThan(0);

		const history = conditionStrategy.candleNeeds(params)["1h"] as number;
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
				nextEvalAt,
				fill: { price: (o) => defaultFillModel(o, bar), time: bar.time },
				inputs: () => ({
					candles: {
						"1h": candles.slice(Math.max(0, i - history + 1), i + 1),
					},
					recent: { timeframeMs: H, candles: [bar] },
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
	candleNeeds: () => ({}),
	recentMs: () => 0,
	validate: () => [],
	evaluate: ({ now, state }) => ({
		intents,
		nextEvalAt: now + H,
		state,
		note: "理由",
	}),
});

const decideWith = (strategy: Strategy<null>, account: Account) =>
	decide({
		strategy,
		params: null,
		now: 10 * H,
		price: 10_000_000,
		candles: {},
		recent: { timeframeMs: H, candles: [] },
		judgments: {},
		account,
		state: null,
		fees: FEES,
		idPrefix: "p",
	});

describe("注文の作成と約定", () => {
	const buyLimit = fixed([
		{
			kind: "place",
			side: "buy",
			type: "limit",
			price: 10_000_000,
			quantity: 1_000_000,
			expireAfterMs: 3 * H,
		},
	]);

	test("指値は期限（戦略が決めた時間）つきで出し、約定で現金と保有が変わる", () => {
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
		expect(expireOrders(placed.account, 13 * H - 1).changed).toEqual([]);
		const out = expireOrders(placed.account, 13 * H);
		expect(out.account.openOrders).toEqual([]);
		expect(out.changed[0]).toMatchObject({
			status: "canceled",
			cancelReason: "指値 10,000,000 が 3時間のあいだ約定しなかったため取消",
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
			{
				kind: "place",
				side: "sell",
				type: "market",
				quantity: 1_000_000,
				lotId: "p1",
			},
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
		expect(sold.account.lots).toEqual([]);
	});

	test("その日（JST）の確定損失が上限に達したら買わず理由を残し、売りは出す。翌 0 時に再開する", () => {
		const both = {
			...fixed([
				{ kind: "place", side: "buy", type: "market", quantity: 1 },
				{
					kind: "place",
					side: "sell",
					type: "market",
					quantity: 1,
					lotId: "b",
				},
			]),
			dailyLossLimit: () => 1_000,
		} satisfies Strategy<null>;
		// 10時（UTC）は JST 19時。その日の 0:00 JST は前日 15:00 UTC
		const day = jstDayStart(10 * H);
		expect(day).toBe(-9 * H);
		const account = {
			...newAccount(1_000_000),
			position: { quantity: 1, entryPrice: 1, openedAt: 0 },
			lots: [
				{
					id: "b",
					quantity: 1,
					entryPrice: 1,
					openedAt: 0,
					cost: 1,
					record: {} as TradeOrder,
				},
			],
			today: { dayStart: day, pnl: -1_000 },
		};
		const out = decideWith(both, account);
		expect(out.changed.map((r) => r.side)).toEqual(["sell"]);
		expect(out.decision.note).toBe(
			"理由。本日の確定損失 1,000 円が1日の損失上限 1,000 円に達したため買わない（翌 0 時に再開）",
		);
		// 含み損は数えない・上限未満なら買う
		const under = decideWith(both, {
			...account,
			today: { dayStart: day, pnl: -999 },
		});
		expect(under.changed.map((r) => r.side)).toEqual(["buy", "sell"]);
		// 前の日の損失は数えない
		const yesterday = decideWith(both, {
			...account,
			today: { dayStart: day - 24 * H, pnl: -5_000 },
		});
		expect(yesterday.changed.map((r) => r.side)).toEqual(["buy", "sell"]);
	});

	test("売りで往復が閉じると、その日の確定損益に足す", () => {
		const placed = decideWith(buyLimit, newAccount(1_000_000));
		const bought = settleFills(placed.account, () => 10_000_000, 11 * H, FEES);
		const sell = fixed([
			{
				kind: "place",
				side: "sell",
				type: "market",
				quantity: 1_000_000,
				lotId: "p1",
			},
		]);
		const sold = settleFills(
			decideWith(sell, bought.account).account,
			() => 9_000_000,
			12 * H,
			FEES,
		);
		expect(sold.account.today).toEqual({
			dayStart: jstDayStart(12 * H),
			pnl: 90_000 - 90 - 100_100,
		});
	});

	test("同じ入力なら同じ結果になる", () => {
		const run = () => {
			const placed = decideWith(buyLimit, newAccount(1_000_000));
			return settleFills(placed.account, () => 10_000_000, 11 * H, FEES);
		};
		expect(run()).toEqual(run());
	});
});

describe("約定データでの約定の判定", () => {
	const order: Order = {
		id: "p1",
		side: "buy",
		type: "limit",
		price: 100,
		quantity: 1,
		placedAt: 10_500,
		expiresAt: null,
		status: "open",
	};
	test("指値は指値以下の売買で指値の価格、成行はその売買の価格で約定する", () => {
		expect(tradeFillPrice(order, { time: 11_000, price: 99 })).toBe(100);
		expect(tradeFillPrice(order, { time: 11_000, price: 101 })).toBeNull();
		expect(
			tradeFillPrice(
				{ ...order, type: "market", price: null },
				{
					time: 11_000,
					price: 101,
				},
			),
		).toBe(101);
	});
	test("注文より前の秒に成立した売買では約定しない", () => {
		expect(tradeFillPrice(order, { time: 9_000, price: 99 })).toBeNull();
		expect(tradeFillPrice(order, { time: 10_000, price: 99 })).toBe(100);
	});
});

describe("ロット", () => {
	const buys = fixed([
		{
			kind: "place",
			side: "buy",
			type: "limit",
			price: 10_000_000,
			quantity: 1_000_000,
		},
		{
			kind: "place",
			side: "buy",
			type: "limit",
			price: 9_000_000,
			quantity: 1_000_000,
		},
	]);

	test("約定した買いを1件ずつロットにし、合計は数量で重み付けした平均の買値", () => {
		const placed = decideWith(buys, newAccount(1_000_000));
		const filled = settleFills(placed.account, (o) => o.price, 11 * H, FEES);
		expect(filled.account.lots.map((l) => [l.id, l.entryPrice])).toEqual([
			["p1", 10_000_000],
			["p2", 9_000_000],
		]);
		expect(filled.account.position).toEqual({
			quantity: 2_000_000,
			entryPrice: 9_500_000,
			openedAt: 11 * H,
		});
	});

	test("買いの id を持つ買いは、約定したロットと戦略へ渡すロットに買いの id を持ち、記録に買いの名前を残す", () => {
		const placed = decideWith(
			fixed([
				{
					kind: "place",
					side: "buy",
					type: "limit",
					price: 10_000_000,
					quantity: 1_000_000,
					buyId: "b2",
					buyName: "突破",
				},
			]),
			newAccount(1_000_000),
		);
		expect(placed.changed[0]?.buyName).toBe("突破");
		const filled = settleFills(placed.account, (o) => o.price, 11 * H, FEES);
		expect(filled.account.lots[0]?.buyId).toBe("b2");
		expect(publicLots(filled.account.lots)[0]?.buyId).toBe("b2");
	});

	test("ロットを指定した売りは、そのロットだけで往復を閉じる", () => {
		const placed = decideWith(buys, newAccount(1_000_000));
		const bought = settleFills(placed.account, (o) => o.price, 11 * H, FEES);
		const sell = fixed([
			{
				kind: "place",
				side: "sell",
				type: "market",
				quantity: 1_000_000,
				lotId: "p2",
			},
		]);
		const sold = settleFills(
			decideWith(sell, bought.account).account,
			() => 9_500_000,
			12 * H,
			FEES,
		);
		expect(sold.trades).toEqual([
			{
				buyOrderId: "p2",
				sellOrderId: "p3",
				entryTime: 11 * H,
				exitTime: 12 * H,
				quantity: 1_000_000,
				pnl: 95_000 - 95 - 90_090,
			},
		]);
		expect(sold.account.lots.map((l) => l.id)).toEqual(["p1"]);
		expect(sold.account.position.entryPrice).toBe(10_000_000);
	});

	test("ロットの一部だけの売りは、支払いを按分してロットを残し、最後の売りで往復を1件にまとめる", () => {
		const placed = decideWith(buys, newAccount(1_000_000));
		const bought = settleFills(placed.account, (o) => o.price, 11 * H, FEES);
		const sellOf = (quantity: number) =>
			fixed([
				{ kind: "place", side: "sell", type: "market", quantity, lotId: "p2" },
			]);
		const half = settleFills(
			decideWith(sellOf(500_000), bought.account).account,
			() => 9_500_000,
			12 * H,
			FEES,
		);
		const firstPnl = 47_500 - 48 - 45_045;
		expect(half.trades).toEqual([]);
		expect(half.account.lots.find((l) => l.id === "p2")).toMatchObject({
			quantity: 500_000,
			cost: 90_090 - 45_045,
			realizedPnl: firstPnl,
			partialExitDone: true,
		});
		expect(half.changed.find((r) => r.id === "p3")).toMatchObject({
			status: "filled",
			pnl: firstPnl,
			pairId: "p2",
		});
		// 買いの記録はロットを閉じるまで売りと対応づけない
		expect(half.changed.map((r) => r.id)).toEqual(["p3"]);
		expect(half.account.today.pnl).toBe(firstPnl);

		const rest = settleFills(
			decideWith(sellOf(500_000), half.account).account,
			() => 10_000_000,
			13 * H,
			FEES,
		);
		const secondPnl = 50_000 - 50 - 45_045;
		expect(rest.trades).toEqual([
			{
				buyOrderId: "p2",
				sellOrderId: "p4",
				entryTime: 11 * H,
				exitTime: 13 * H,
				quantity: 1_000_000,
				pnl: firstPnl + secondPnl,
			},
		]);
		expect(rest.changed.find((r) => r.id === "p4")?.pnl).toBe(secondPnl);
		expect(rest.changed.find((r) => r.id === "p2")?.pairId).toBe("p4");
		expect(rest.account.lots.map((l) => l.id)).toEqual(["p1"]);
	});

	test("ロットが無い・数量が多すぎる・売りが約定待ちなら売りを出さない", () => {
		const placed = decideWith(buys, newAccount(1_000_000));
		const bought = settleFills(placed.account, (o) => o.price, 11 * H, FEES);
		const sellOf = (lotId: string, quantity = 1_000_000) =>
			fixed([{ kind: "place", side: "sell", type: "market", quantity, lotId }]);
		expect(decideWith(sellOf("x"), bought.account).decision.note).toContain(
			"売るロットが無い",
		);
		expect(
			decideWith(sellOf("p1", 2_000_000), bought.account).decision.note,
		).toContain("を超える数量は売れない");
		const once = decideWith(sellOf("p1"), bought.account);
		expect(decideWith(sellOf("p1"), once.account).decision.note).toContain(
			"約定待ち",
		);
	});

	test("未約定の買いの額を除いた資金で、次の買いを出せるか見る", () => {
		const out = decideWith(buys, newAccount(150_000));
		expect(out.changed.map((r) => r.id)).toEqual(["p1"]);
		expect(out.decision.note).toContain("未約定の買い 100,100 円を除く");
	});

	test("同時に出した買いが先に約定して資金が足りなくなったら、約定時に取り消す", () => {
		const placed = decideWith(buys, newAccount(200_000));
		const out = settleFills(
			{ ...placed.account, cash: 150_000 },
			(o) => o.price,
			11 * H,
			FEES,
		);
		expect(out.account.lots).toHaveLength(1);
		expect(out.changed[1]).toMatchObject({ id: "p2", status: "canceled" });
	});
});

describe("normalizeAccount", () => {
	const record = { id: "o1", fillPrice: 10_000_000 } as TradeOrder;

	test("ロットを持つ前の口座は、保有を1ロットとして読み、ロットを持たない売りをそのロットの売りにする", () => {
		const sell: Order = {
			id: "o2",
			side: "sell",
			type: "market",
			price: null,
			quantity: 1_000_000,
			placedAt: 0,
			expiresAt: null,
			status: "open",
		};
		const a = normalizeAccount({
			cash: 500,
			position: { quantity: 1_000_000, entryPrice: 10_000_000, openedAt: 5 },
			entry: { record, time: 5, cost: 100_100 },
			openOrders: [{ order: sell, record: {} as TradeOrder }],
			seq: 2,
		});
		expect(a.lots).toEqual([
			{
				id: "o1",
				quantity: 1_000_000,
				entryPrice: 10_000_000,
				openedAt: 5,
				cost: 100_100,
				record,
			},
		]);
		expect(a.openOrders[0]?.order.lotId).toBe("o1");
		expect(a.today).toEqual({ dayStart: 0, pnl: 0 });
		expect(a).not.toHaveProperty("entry");
	});

	test("今の形の口座はそのまま読む", () => {
		const a = newAccount(1_000);
		expect(normalizeAccount(JSON.parse(JSON.stringify(a)))).toEqual(a);
	});
});

describe("withSellDetails", () => {
	test("売りに、売るロット（対応する買い）の約定価格を添える", () => {
		const o = (x: Partial<TradeOrder>) => x as TradeOrder;
		expect(
			withSellDetails([
				o({ id: "b", side: "buy", fillPrice: 100, pairId: "s" }),
				o({ id: "s", side: "sell", fillPrice: 120, pairId: "b", reason: "" }),
				o({ id: "t", side: "sell", fillPrice: 90, pairId: null, reason: "" }),
			]).map((x) => x.lotPrice),
		).toEqual([null, 100, null]);
	});
});

describe("inferExitKind", () => {
	const sell = (reason: string, exitKind?: ExitKind | null) => ({
		side: "sell" as const,
		reason,
		exitKind,
	});

	test("記録があればそれを使う", () => {
		expect(inferExitKind(sell("", "takeProfit"), null)).toBe("takeProfit");
	});

	test("買いは null", () => {
		expect(
			inferExitKind({ ...sell("", "stopLoss"), side: "buy" }, null),
		).toBeNull();
	});

	test("記録の無い注文は理由の文から読む", () => {
		expect(
			inferExitKind(
				sell(
					"買値から −2% 以上下がったため保有中の 0.001 BTC を売却（損切りの条件）",
				),
				null,
			),
		).toBe("stopLoss");
	});

	test("複数のロットを売った理由は、ロットの買値で自分の文を選ぶ", () => {
		const reason =
			"A のため買値 10,000,000 のロット 0.001 BTC を売却（利確の条件）。B のため買値 9,500,000 のロット 0.001 BTC を売却（損切りの条件）";
		expect(inferExitKind(sell(reason), 10_000_000)).toBe("takeProfit");
		expect(inferExitKind(sell(reason), 9_500_000)).toBe("stopLoss");
		expect(inferExitKind(sell(reason), null)).toBeNull();
	});

	test("一部利確の文も、ロットの買値で自分の文を選べる", () => {
		const reason =
			"A のため買値 10,000,000 のロット 0.010 BTC のうち 0.005 BTC を売却（一部利確の条件）。B のため買値 9,500,000 のロット 0.010 BTC を売却（利確の条件）";
		expect(inferExitKind(sell(reason), 10_000_000)).toBe("partialTakeProfit");
		expect(inferExitKind(sell(reason), 9_500_000)).toBe("takeProfit");
	});

	test("読めなければ null", () => {
		expect(inferExitKind(sell("売りの条件を満たさない"), null)).toBeNull();
	});
});
