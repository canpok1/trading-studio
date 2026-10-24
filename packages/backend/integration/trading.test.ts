import { describe, expect, test } from "bun:test";
import type {
	ConditionSet,
	MarketTrade,
	SingleBuyConditionSet,
} from "@trading-studio/core";
import {
	BTC_JPY,
	DEFAULT_DAILY_LOSS_LIMIT,
	DEFAULT_PARTIAL_SELL,
	ETH_JPY,
	MARKET_BUY_ORDER,
	singleBuy,
} from "@trading-studio/core";
import { SqliteTradingRepository } from "../src/trading/repository-infra";
import { createTradingService } from "../src/trading/trading-domain";
import type {
	AutoTradingStatus,
	StoredOrder,
	StrategySummary,
} from "../src/trading/types-domain";
import { createTestApp, TEST_FEE_RATES } from "./test-app";

const M = 60_000;
const T0 = 1_800_000_000_000; // 分の区切り
const P = 10_000_000;

type Json = Record<string, unknown>;

/** 1分ごとに評価し、いつでも買い、買値から1%動いたら売る戦略 */
const always = (over: Partial<SingleBuyConditionSet> = {}): ConditionSet =>
	singleBuy({
		dailyLossLimit: DEFAULT_DAILY_LOSS_LIMIT,
		stopLossCooldownBars: 0,
		stopLossCooldownTimeframe: "1h",
		partialTakeProfit: { match: "all", conditions: [] },
		partialSell: DEFAULT_PARTIAL_SELL,
		frequency: {
			flat: { value: 1, unit: "m" },
			holding: { value: 1, unit: "m" },
		},
		orderSize: 1_000_000,
		maxPositions: 1,
		buy: {
			match: "all",
			conditions: [
				{
					type: "judgment",
					judge: "sentiment",
					values: ["+2", "+1", "0", "-1", "-2", "none"],
				},
			],
		},
		buyOrder: MARKET_BUY_ORDER,
		takeProfit: {
			match: "any",
			conditions: [{ type: "entryChange", percent: 1, direction: "up" }],
		},
		stopLoss: {
			match: "any",
			conditions: [{ type: "entryChange", percent: 1, direction: "down" }],
		},
		...over,
	});

function setup(params: ConditionSet = always(), instruments?: string[]) {
	const t = createTestApp();
	t.clock.now = T0 + 30_000;
	t.marketDataRepo.upsertCollected(
		Array.from({ length: 5 }, (_, i) => ({
			time: T0 - (5 - i) * M,
			open: P,
			high: P,
			low: P,
			close: P,
			volume: 0,
		})),
	);
	let id = 0;
	const trade = (price: number, time = t.clock.now): MarketTrade => ({
		id: ++id,
		time,
		price,
		quantity: 1,
	});
	t.live.current = { ...t.live.current, latestTrade: trade(P) };
	const s = t.trading.createStrategy({
		name: "常に買う",
		from: { params, ...(instruments ? { instruments } : {}) },
	});
	if (!s.ok) throw new Error(JSON.stringify(s.error));
	/** この戦略の操作は /start のように書ける */
	const call = async (method: string, path: string, body?: unknown) => {
		const url = /^\/(start|stop|reset|performance|watch)/.test(path)
			? `/strategies/${s.strategy.id}${path}`
			: path;
		const res = await t.app.request(`/api/trading${url}`, {
			method,
			headers: body ? { "content-type": "application/json" } : {},
			body: body ? JSON.stringify(body) : undefined,
		});
		return { status: res.status, body: (await res.json()) as Json };
	};
	/** 時刻を進めて見回りを1回 */
	const at = (time: number) => {
		t.clock.now = time;
		// 形成中の1分足は今の価格の横ばいにする
		const price = t.live.current.latestTrade?.price ?? P;
		t.live.current = {
			...t.live.current,
			forming: {
				time: Math.floor((time - 1) / M) * M,
				open: price,
				high: price,
				low: price,
				close: price,
				volume: 0,
			},
		};
		t.trading.tick();
	};
	/** 約定が届く。現在値も更新する */
	const fill = (price: number) => {
		const tr = trade(price);
		t.live.current = { ...t.live.current, latestTrade: tr };
		t.trading.onTrades(BTC_JPY.id, [tr]);
	};
	const orders = () =>
		t.trading.orders({}).sort((a, b) => a.placedAt - b.placedAt);
	const status = () => t.trading.run(s.strategy.id) as AutoTradingStatus;
	return { ...t, strategy: s.strategy, call, at, fill, orders, status };
}

/** 採点の記録を始める（点数はすべて関係なし＝中立の判定） */
function startScoring(t: ReturnType<typeof setup>, at: number) {
	const source = t.newsRepo.insertSource(
		{ name: "S", url: "https://a.example/feed", language: "ja" },
		0,
	);
	t.newsRepo.saveFetched(
		source,
		[
			{
				title: "n",
				url: "https://a.example/n",
				summary: null,
				publishedAt: at,
			},
		],
		at,
	);
	const id = (t.newsRepo.listNews(1)[0] as { id: number }).id;
	t.scoreRepo.saveScore(
		id,
		{ scores: { sentiment: 0, risk: 0 }, duration: "none", comment: "c" },
		{
			scoredAt: at,
			criteriaVersion: 1,
			model: "m",
			appBuiltAt: null,
			attempts: 0,
		},
	);
}

describe("自動取引のオンオフ", () => {
	test("オンにすると戦略の粒度の次の足の終わりに評価し、条件どおりに仮想注文を出す", async () => {
		const t = setup();
		startScoring(t, T0);
		const started = await t.call("POST", "/start");
		expect(started.status).toBe(200);
		const st = started.body.status as AutoTradingStatus;
		expect(st.enabled).toBe(true);
		expect(st.name).toBe("常に買う");
		expect(st.nextEvalAt).toBe(T0 + M);

		t.at(T0 + M - 1);
		expect(t.orders()).toEqual([]);
		t.at(T0 + M);
		expect(t.orders()).toMatchObject([
			{
				id: "p1",
				side: "buy",
				type: "market",
				status: "open",
				strategyName: "常に買う",
			},
		]);
		const detail = t.trading.order(1, "p1");
		expect(detail?.decision?.judgments).toEqual({
			sentiment: "0",
			risk: "calm",
		});
		expect(detail?.decision?.decision.time).toBe(T0 + M);
		const api = await t.call("GET", "/orders/1/p1");
		expect(api.body).toMatchObject({
			order: { id: "p1", strategyId: 1, mode: "paper" },
			judgments: { sentiment: "0" },
		});
		expect((await t.call("GET", "/orders/1/p9")).status).toBe(404);
	});

	test("採点の記録が始まる前はデータなしとして判定し、判定を記録しない", async () => {
		const t = setup(
			always({
				buy: {
					match: "all",
					conditions: [
						{ type: "judgment", judge: "sentiment", values: ["none"] },
					],
				},
			}),
		);
		await t.call("POST", "/start");
		t.at(T0 + M);
		expect(t.orders()).toHaveLength(1);
		expect(t.trading.order(1, "p1")?.decision?.judgments).toEqual({});
	});

	test("リアルの口座は動かせず、条件が足りなければオンにできない", async () => {
		const t = setup();
		t.db.$client.run("update trading_runs set mode = 'live'");
		expect((await t.call("POST", "/start")).body.kind).toBe("unsupported_mode");
		const blank = t.trading.createStrategy({
			name: "空",
			from: { template: "blank" },
		});
		if (!blank.ok) throw new Error();
		const r = await t.call("POST", `/strategies/${blank.strategy.id}/start`);
		expect(r.status).toBe(400);
		expect(r.body.kind).toBe("invalid_strategy");
		expect((await t.call("POST", "/strategies/99/start")).status).toBe(404);
	});

	test("価格を集めていない銘柄を候補にした戦略はオンにできない", async () => {
		const t = setup();
		t.db.$client.run(
			`update strategies set instruments = '["coincheck:btc_jpy","coincheck:doge_jpy"]'`,
		);
		const r = await t.call("POST", "/start");
		expect(r.status).toBe(400);
		expect(r.body.kind).toBe("unsupported_instrument");
	});

	test("オフにすると新しい注文を出さず、未約定の注文は残る", async () => {
		const t = setup(
			always({
				buyOrder: {
					lines: [{ type: "limit", belowPercent: 1 }],
					expireBars: 10,
					expireTimeframe: "1m",
				},
			}),
		);
		await t.call("POST", "/start");
		t.at(T0 + M);
		expect(t.orders()).toHaveLength(1);
		expect((await t.call("POST", "/stop")).status).toBe(200);
		t.at(T0 + 5 * M);
		expect(t.orders()).toMatchObject([{ status: "open" }]);
		expect(t.status().enabled).toBe(false);
	});
});

describe("仮想の約定", () => {
	test("成行は次に来た約定の価格で約定し、現金・保有・手数料が変わる。約定で評価し直して売る", async () => {
		const t = setup();
		await t.call("POST", "/start");
		t.at(T0 + M);
		t.fill(P);
		expect(t.orders()[0]).toMatchObject({
			status: "filled",
			fillPrice: P,
			fee: 100,
		});
		expect(t.status().account).toMatchObject({
			cash: 1_000_000 - 100_000 - 100,
			position: { quantity: 1_000_000, entryPrice: P },
		});

		// 約定したので次の判定時刻を待たずに評価する。まだ1%動いていないので売らない
		t.at(T0 + M + 1_000);
		expect(t.orders()).toHaveLength(1);
		t.fill(P * 1.02);
		// 評価し直した時刻から1分後
		t.at(T0 + 2 * M + 1_000);
		expect(t.orders()[1]).toMatchObject({
			side: "sell",
			type: "market",
			status: "open",
		});
		t.fill(P * 1.02);
		expect(t.orders()[1]).toMatchObject({
			status: "filled",
			fillPrice: P * 1.02,
			pairId: "p1",
			pnl: 102_000 - 102 - 100_100,
		});
		expect(t.orders()[0]?.pairId).toBe("p2");
		expect(t.status().account.cash).toBe(1_000_000 + 102_000 - 102 - 100_100);

		const ids = async (query: string) =>
			(
				(await t.call("GET", `/orders?${query}`)).body.orders as StoredOrder[]
			).map((o) => o.id);
		expect(await ids("strategy=1")).toEqual(["p2", "p1"]);
		expect(await ids("strategy=1&limit=1")).toEqual(["p2"]);
		expect(await ids("side=buy&status=filled")).toEqual(["p1"]);
		expect(await ids("strategy=2")).toEqual([]);
		// 件数と損益の合計は件数の指定で切らない
		expect((await t.call("GET", "/orders?limit=1")).body).toMatchObject({
			count: 2,
			realizedPnl: 102_000 - 102 - 100_100,
		});
	});

	test("指値は指値以下の約定が来たら指値で約定し、跨がなければ約定しない", async () => {
		const t = setup(
			always({
				buyOrder: {
					lines: [{ type: "limit", belowPercent: 1 }],
					expireBars: 3,
					expireTimeframe: "1m",
				},
			}),
		);
		await t.call("POST", "/start");
		t.at(T0 + M);
		const limit = t.orders()[0]?.price as number;
		expect(limit).toBe(9_900_000);
		t.fill(9_900_001);
		expect(t.orders()[0]?.status).toBe("open");
		t.fill(9_800_000);
		expect(t.orders()[0]).toMatchObject({
			status: "filled",
			fillPrice: 9_900_000,
		});
	});

	test("指値は指値の足 M 本ぶんの時間が過ぎたら取り消す", async () => {
		const t = setup(
			always({
				buyOrder: {
					lines: [{ type: "limit", belowPercent: 1 }],
					expireBars: 3,
					expireTimeframe: "1m",
				},
			}),
		);
		await t.call("POST", "/start");
		t.at(T0 + M);
		await t.call("POST", "/stop");
		t.at(T0 + 4 * M - 1);
		expect(t.orders()[0]?.status).toBe("open");
		t.at(T0 + 4 * M);
		expect(t.orders()[0]).toMatchObject({
			status: "canceled",
			cancelReason: "指値 9,900,000 が 3分のあいだ約定しなかったため取消",
		});
	});

	test("成行の買いは約定時に手数料込みの額が足りなければ取り消す", async () => {
		const t = setup();
		await t.call("POST", "/reset", { initialCash: 100_000 });
		await t.call("POST", "/start");
		t.at(T0 + M);
		t.fill(P);
		expect(t.orders()[0]).toMatchObject({
			status: "canceled",
			cancelReason:
				"資金 100,000 円が手数料込みの約定額 100,100 円に足りないため取消",
		});
		expect(t.status().account.cash).toBe(100_000);
	});
});

describe("止まっていた間と再起動", () => {
	test("収集が止まっている間は判定せず、復帰したら過ぎた判定を1回だけ行う", async () => {
		const t = setup(
			always({
				buyOrder: {
					lines: [{ type: "limit", belowPercent: 1 }],
					expireBars: 100,
					expireTimeframe: "1m",
				},
			}),
		);
		await t.call("POST", "/start");
		const running = t.live.current.status;
		t.live.current = {
			...t.live.current,
			status: { ...running, state: "stopped" },
		};
		t.at(T0 + M);
		t.at(T0 + 5 * M);
		expect(t.orders()).toEqual([]);
		expect(t.status().waitingForMarket).toBe(true);
		t.live.current = { ...t.live.current, status: running };
		t.at(T0 + 5 * M + 1_000);
		t.at(T0 + 5 * M + 2_000);
		expect(t.orders()).toHaveLength(1);
		expect(t.status().nextEvalAt).toBe(T0 + 6 * M + 1_000);
	});

	test("再起動しても state・未約定の注文・次の判定時刻を DB から戻して続きから動く", async () => {
		const t = setup(
			always({
				buyOrder: {
					lines: [{ type: "limit", belowPercent: 1 }],
					expireBars: 100,
					expireTimeframe: "1m",
				},
			}),
		);
		await t.call("POST", "/start");
		t.at(T0 + M);
		const before = t.status();
		// 同じ DB で作り直す（再起動）
		const restarted = createTradingService({
			repo: new SqliteTradingRepository(t.db),
			strategies: t.strategies,
			judgments: {
				current: () => {
					throw new Error("約定だけなので判定は使わない");
				},
			},
			calendar: t.calendar,
			dvol: t.dvolRepo,
			marketData: [t.marketDataRepo],
			market: () => t.live.current,
			fees: TEST_FEE_RATES,
			now: () => t.clock.now,
		});
		expect(restarted.run(t.strategy.id)).toEqual(before);
		const tr: MarketTrade = {
			id: 99,
			time: t.clock.now,
			price: 9_000_000,
			quantity: 1,
		};
		restarted.onTrades(BTC_JPY.id, [tr]);
		expect(restarted.orders({})[0]).toMatchObject({
			id: "p1",
			status: "filled",
		} satisfies Partial<StoredOrder>);
	});
});

describe("口座のリセット", () => {
	test("オフのときだけ、開始時の資金に戻し未約定の注文を取り消す。過去の記録は残る", async () => {
		const t = setup(
			always({
				buyOrder: {
					lines: [{ type: "limit", belowPercent: 1 }],
					expireBars: 100,
					expireTimeframe: "1m",
				},
			}),
		);
		await t.call("POST", "/start");
		t.at(T0 + M);
		expect(
			(await t.call("POST", "/reset", { initialCash: 500_000 })).status,
		).toBe(409);
		await t.call("POST", "/stop");
		const r = await t.call("POST", "/reset", { initialCash: 500_000 });
		expect(r.status).toBe(200);
		expect((r.body.status as AutoTradingStatus).account).toMatchObject({
			initialCash: 500_000,
			cash: 500_000,
			position: { quantity: 0 },
			openOrderCount: 0,
		});
		expect(t.orders()).toMatchObject([
			{ id: "p1", status: "canceled", cancelReason: "口座のリセットで取消" },
		]);
		// 通し番号は引き継ぎ、過去の注文と id が重ならない
		await t.call("POST", "/start");
		t.at(T0 + 3 * M);
		expect(t.orders().map((o) => o.id)).toEqual(["p1", "p2"]);
	});

	test("リセットから一度でもオンにしたかを返し、リセットで戻る", async () => {
		const t = setup();
		expect(t.status().ranSinceReset).toBe(false);
		await t.call("POST", "/start");
		expect(t.status().ranSinceReset).toBe(true);
		t.at(T0 + M);
		await t.call("POST", "/stop");
		expect(t.status().ranSinceReset).toBe(true);
		t.clock.now = T0 + 2 * M;
		await t.call("POST", "/reset", { initialCash: 1_000_000 });
		expect(t.status().ranSinceReset).toBe(false);
	});

	test("開始時の資金は1円以上の整数", async () => {
		const t = setup();
		expect((await t.call("POST", "/reset", { initialCash: 0 })).status).toBe(
			400,
		);
		expect((await t.call("POST", "/reset", { initialCash: 1.5 })).status).toBe(
			400,
		);
	});
});

describe("1日の損失上限", () => {
	test("その日の確定損失が上限に達すると買いを止め、売りは続ける。状態に本日の損失と上限を出す", async () => {
		const t = setup(always({ dailyLossLimit: 1_000 }));
		await t.call("POST", "/start");
		t.at(T0 + M);
		t.fill(P);
		t.fill(P * 0.98);
		t.at(T0 + 2 * M + 1_000);
		t.fill(P * 0.98);
		expect(t.orders().map((o) => [o.side, o.status])).toEqual([
			["buy", "filled"],
			["sell", "filled"],
		]);
		const st = t.status();
		expect(st.dailyLoss).toEqual({
			loss: 100_100 - (98_000 - 98),
			limit: 1_000,
			blocked: true,
		});
		t.at(T0 + 4 * M);
		expect(t.orders()).toHaveLength(2);
		const last = t.tradingRepo.decision(3);
		expect(last?.decision.note).toContain(
			"1日の損失上限 1,000 円に達したため買わない",
		);
	});
});

describe("オン中の制限", () => {
	test("動かしている戦略が消えたら止まる", async () => {
		const t = setup();
		await t.call("POST", "/start");
		t.strategies.remove(t.strategy.id);
		t.at(T0 + M);
		expect(t.tradingRepo.runs()[0]?.enabled).toBe(false);
	});

	test("オン中と保有がある間は条件の変更ができず、オン中は削除もできない。名前とほかの戦略は変えられる", async () => {
		const t = setup();
		const req = async (method: string, path: string, body?: unknown) =>
			(
				await t.app.request(`/api/strategies${path}`, {
					method,
					headers: body ? { "content-type": "application/json" } : {},
					body: body ? JSON.stringify(body) : undefined,
				})
			).status;
		const id = t.strategy.id;
		const other = t.strategies.create({
			name: "別",
			from: { params: always() },
		});
		if (!other.ok) throw new Error();

		await t.call("POST", "/start");
		expect(t.status().strategyLock).toBe("running");
		expect(await req("PUT", `/${id}/params`, { params: always() })).toBe(409);
		expect(await req("DELETE", `/${id}`)).toBe(409);
		expect(await req("PUT", `/${id}/name`, { name: "改名" })).toBe(200);
		expect(t.status().name).toBe("改名");
		expect(
			await req("PUT", `/${other.strategy.id}/params`, { params: always() }),
		).toBe(200);

		t.at(T0 + M);
		t.fill(P);
		await t.call("POST", "/stop");
		expect(t.status().strategyLock).toBe("holding");
		expect(await req("PUT", `/${id}/params`, { params: always() })).toBe(409);

		expect(
			(await t.call("POST", "/reset", { initialCash: 100_000_000 })).status,
		).toBe(200);
		expect(t.status().strategyLock).toBe(null);
		expect(await req("PUT", `/${id}/params`, { params: always() })).toBe(200);
	});
});

describe("成績", () => {
	test("口座をリセットした時点以降の約定から損益・勝率・最大DDを出し、状態に今の価格で評価した資産を出す", async () => {
		const t = setup();
		const resetAt = t.status().account.resetAt;
		await t.call("POST", "/start");
		t.at(T0 + M);
		t.fill(P);
		// 保有中は今の価格で評価する（手数料は含めない）
		expect(t.status().account.equity).toBe(1_000_000 - 100_100 + 100_000);
		t.at(T0 + M + 1_000);
		t.fill(P * 1.02);
		t.at(T0 + 2 * M + 1_000);
		t.fill(P * 1.02);
		const pnl = 102_000 - 102 - 100_100;

		const r = await t.call("GET", "/performance");
		expect(r.status).toBe(200);
		expect(r.body.performance).toMatchObject({
			resetAt,
			initialCash: 1_000_000,
			equity: 1_000_000 + pnl,
			pnl,
			pnlPercent: (pnl / 1_000_000) * 100,
			realizedPnl: pnl,
			trades: 1,
			wins: 1,
			losses: 0,
			winRate: 100,
			profitFactor: null,
			// 買いの約定の直後に手数料ぶん下がった
			maxDrawdownPercent: (100 / 1_000_000) * 100,
			maxDrawdownFrom: resetAt,
		});
		expect(t.status().account.equity).toBe(1_000_000 + pnl);

		// リセットすると前の約定は数えない
		await t.call("POST", "/stop");
		await t.call("POST", "/reset", { initialCash: 500_000 });
		expect(
			(await t.call("GET", "/performance")).body.performance,
		).toMatchObject({
			initialCash: 500_000,
			equity: 500_000,
			pnl: 0,
			realizedPnl: 0,
			trades: 0,
			winRate: null,
			maxDrawdownPercent: 0,
		});
		expect((await t.call("GET", "/strategies/9/performance")).status).toBe(404);
	});
});

describe("複数ポジション", () => {
	test("買いが複数なら、注文に買いの名前を残し、ロットは買った買いの売りの条件で売る", async () => {
		const base = always();
		const rule = base.buys[0] as ConditionSet["buys"][number];
		const t = setup({
			...base,
			buys: [
				{ ...rule, name: "押し目" },
				{
					...rule,
					id: "b2",
					name: "突破",
					takeProfit: {
						match: "any",
						conditions: [{ type: "entryChange", percent: 5, direction: "up" }],
					},
				},
			],
		});
		await t.call("POST", "/start", { mode: "paper" });
		t.at(T0 + M);
		expect(t.orders().map((o) => [o.side, o.buyName])).toEqual([
			["buy", "押し目"],
		]);
		t.fill(P);
		t.at(T0 + M + 1000);
		expect(t.status().account.lots.map((l) => l.buyId)).toEqual(["b1"]);
		// 押し目の利確（+1%）で売る
		t.fill(P * 1.02);
		t.at(T0 + 2 * M);
		expect(t.orders().at(-1)).toMatchObject({
			side: "sell",
			exitKind: "takeProfit",
			buyName: null,
		});
	});

	test("同時に出した買いがそれぞれロットになり、ロットごとに売る。売りには売るロットの買値を添える", async () => {
		const t = setup(
			always({
				maxPositions: 2,
				buyOrder: {
					lines: [{ type: "market" }, { type: "limit", belowPercent: 0.5 }],
					expireBars: 10,
					expireTimeframe: "1m",
				},
			}),
		);
		await t.call("POST", "/start");
		t.at(T0 + M);
		expect(
			t
				.orders()
				.sort((a, b) => a.id.localeCompare(b.id))
				.map((o) => [o.id, o.type, o.price]),
		).toEqual([
			["p1", "market", null],
			["p2", "limit", 9_950_000],
		]);
		t.fill(P);
		t.at(T0 + M + 1000);
		t.fill(9_950_000);
		t.at(T0 + M + 2000);
		expect(t.status().account.lots.map((l) => [l.id, l.entryPrice])).toEqual([
			["p1", P],
			["p2", 9_950_000],
		]);
		// p2 だけ買値から +1%
		t.fill(10_060_000);
		t.at(T0 + 3 * M);
		const sell = t.orders().find((o) => o.side === "sell") as StoredOrder;
		expect(sell).toMatchObject({ pairId: "p2", lotPrice: 9_950_000 });
		t.fill(10_060_000);
		expect(t.status().account.lots.map((l) => l.id)).toEqual(["p1"]);
		expect(t.trading.order(1, sell.id)?.order).toMatchObject({
			status: "filled",
			lotPrice: 9_950_000,
		});
	});

	test("ロットを持つ前に保存した口座は、保有を1ロットとして読む", () => {
		const t = setup();
		t.db.$client.run(
			"update trading_runs set account = ? where strategy_id = ?",
			[
				JSON.stringify({
					cash: 900_000,
					position: { quantity: 1_000_000, entryPrice: P, openedAt: T0 },
					entry: { record: { id: "p1" }, time: T0, cost: 100_100 },
					openOrders: [],
					seq: 1,
				}),
				1,
			],
		);
		expect(t.status().account.lots).toEqual([
			{
				id: "p1",
				quantity: 1_000_000,
				entryPrice: P,
				openedAt: T0,
				partialExitDone: false,
				buyId: null,
			},
		]);
	});
});

describe("複数の戦略", () => {
	const create = async (
		t: ReturnType<typeof setup>,
		name: string,
		params: ConditionSet = always(),
	) => {
		const res = await t.app.request("/api/strategies", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name, from: { params } }),
		});
		expect(res.status).toBe(201);
		return ((await res.json()) as { strategy: { id: number } }).strategy.id;
	};

	test("戦略ごとに口座・注文・オンオフを持ち、別々に動く", async () => {
		const t = setup();
		const second = await create(t, "比較用");
		await t.call("POST", `/strategies/${second}/reset`, {
			initialCash: 500_000,
		});
		await t.call("POST", "/start");
		await t.call("POST", `/strategies/${second}/start`);
		t.at(T0 + M);
		t.fill(P);
		// どちらも買い、注文の id は口座の中で振る
		expect(
			t
				.orders()
				.map((o) => [o.strategyName, o.id, o.status])
				.sort(),
		).toEqual([
			["常に買う", "p1", "filled"],
			["比較用", "p1", "filled"],
		]);
		expect(t.trading.run(second)?.account.cash).toBe(500_000 - 100_100);
		expect(t.status().account.cash).toBe(1_000_000 - 100_100);
		expect((await t.call("GET", `/orders?strategy=${second}`)).body.count).toBe(
			1,
		);
		expect((await t.call("GET", "/orders?strategy=99")).body.count).toBe(0);
		expect((await t.call("GET", `/orders/${second}/p1`)).body).toMatchObject({
			order: { strategyName: "比較用" },
		});

		// 片方を止めても、もう片方は動き続ける
		await t.call("POST", "/stop");
		t.fill(10_200_000);
		t.at(T0 + 2 * M);
		t.fill(10_200_000);
		expect(t.trading.run(second)?.account.lots).toEqual([]);
		expect(t.status().account.lots).toHaveLength(1);
		expect(
			(await t.call("GET", "/strategies")).body
				.strategies as AutoTradingStatus[],
		).toMatchObject([
			{ id: t.strategy.id, name: "常に買う", enabled: false, mode: "paper" },
			{ id: second, name: "比較用", enabled: true, mode: "paper" },
		]);
	});

	test("ホームの要約はオンの戦略と、オフでも保有がある戦略だけを作った順に返す", async () => {
		const t = setup();
		const idle = await create(t, "止めたまま");
		const running = await create(t, "動かす");
		await t.call("POST", "/start");
		await t.call("POST", `/strategies/${running}/start`);
		t.at(T0 + M);
		t.fill(P);
		// 買った後に止めても、保有があるので出す
		await t.call("POST", "/stop");
		const body = (await t.call("GET", "/summaries")).body as {
			summaries: StrategySummary[];
		};
		expect(body.summaries.map((x) => x.status.id)).toEqual([
			t.strategy.id,
			running,
		]);
		expect(body.summaries.map((x) => x.status.id)).not.toContain(idle);
		const [held] = body.summaries;
		expect(held?.status.enabled).toBe(false);
		expect(held?.performance?.initialCash).toBe(1_000_000);
		expect(held?.nextMoves?.price).toBe(P);
		expect(held?.nextMoves?.multiBuy).toBe(false);
	});

	test("1つの口座が読めなくても、ほかの戦略は約定・評価を続ける", async () => {
		const t = setup();
		const broken = await create(t, "壊れた");
		t.db.$client.run(
			"update trading_runs set account = '{' where strategy_id = ?",
			[broken],
		);
		await t.call("POST", "/start");
		t.at(T0 + M);
		t.fill(P);
		expect(t.orders().map((o) => [o.strategyName, o.status])).toEqual([
			["常に買う", "filled"],
		]);
	});

	test("同時にオンにできるのは5つまで", async () => {
		const t = setup();
		await t.call("POST", "/start");
		for (const name of ["a", "b", "c", "d"]) {
			const id = await create(t, name);
			expect((await t.call("POST", `/strategies/${id}/start`)).status).toBe(
				200,
			);
		}
		const sixth = await create(t, "e");
		const r = await t.call("POST", `/strategies/${sixth}/start`);
		expect(r.status).toBe(409);
		expect(r.body.kind).toBe("limit");
		await t.call("POST", "/stop");
		expect((await t.call("POST", `/strategies/${sixth}/start`)).status).toBe(
			200,
		);
	});

	test("戦略はオフのときだけ消せる。未約定は取り消し保有は捨て、記録は残す", async () => {
		const t = setup(
			always({
				buyOrder: {
					lines: [{ type: "limit", belowPercent: 5 }],
					expireBars: 100,
					expireTimeframe: "1m",
				},
			}),
		);
		const del = async () =>
			(
				await t.app.request(`/api/strategies/${t.strategy.id}`, {
					method: "DELETE",
				})
			).status;
		await t.call("POST", "/start");
		t.at(T0 + M);
		expect(await del()).toBe(409);
		await t.call("POST", "/stop");
		expect(await del()).toBe(200);
		expect(t.trading.runs()).toEqual([]);
		expect(t.strategies.get(t.strategy.id)).toBeNull();
		expect(t.orders()).toMatchObject([
			{ status: "canceled", cancelReason: "戦略の削除で取消" },
		]);
		expect(t.tradingRepo.runs()).toEqual([]);
		expect((await t.call("POST", "/start")).status).toBe(404);
		expect(await del()).toBe(404);
	});

	test("戦略を作ると既定の資金のデモの口座を作り、戦略だけの行は一覧に出さない", async () => {
		const t = setup();
		expect(t.trading.runs()).toMatchObject([
			{
				id: t.strategy.id,
				enabled: false,
				mode: "paper",
				account: {
					initialCash: 1_000_000,
					cash: 1_000_000,
					resetAt: t.clock.now,
				},
			},
		]);
		const bare = t.strategies.create({
			name: "口座なし",
			from: { template: "blank" },
		});
		if (!bare.ok) throw new Error();
		expect(t.trading.runs()).toHaveLength(1);
		expect(t.trading.run(bare.strategy.id)).toBeNull();
	});
});

describe("見張り", () => {
	test("今の価格で試算し、保有の利確・損切りの発動価格を返す。注文も state も変えない", async () => {
		const t = setup();
		await t.call("POST", "/start");
		t.at(T0 + M);
		t.fill(P);
		const before = t.orders().length;
		const res = await t.call("GET", "/watch");
		expect(res.status).toBe(200);
		const w = res.body.watch as {
			actions: { kind: string; price: number | null }[];
		};
		expect(w.actions.map((a) => [a.kind, a.price])).toEqual([
			["stopLoss", P * 0.99],
			["takeProfit", P * 1.01],
		]);
		expect(t.orders().length).toBe(before);
		expect((await t.call("GET", "/strategies/9/watch")).status).toBe(404);
	});
});

describe("候補が2つ以上の戦略（ADR 0037）", () => {
	const E = 500_000; // ETH の価格（円）

	/** BTC と ETH を候補にし、どちらも1回 100,000円ずつ買う */
	function multi(maxHoldings: number, instruments = [BTC_JPY.id, ETH_JPY.id]) {
		const t = setup(
			{ ...always({ orderAmount: 100_000 }), maxHoldings },
			instruments,
		);
		t.repoOf(ETH_JPY.id).upsertCollected(
			Array.from({ length: 5 }, (_, i) => ({
				time: T0 - (5 - i) * M,
				open: E,
				high: E,
				low: E,
				close: E,
				volume: 0,
			})),
		);
		const eth = t.liveOf(ETH_JPY.id);
		/** ETH の約定が届く */
		const fillEth = (price: number) => {
			const tr: MarketTrade = {
				id: 1_000 + t.orders().length,
				time: t.clock.now,
				price,
				quantity: 1,
			};
			eth.current = { ...eth.current, latestTrade: tr };
			t.trading.onTrades(ETH_JPY.id, [tr]);
		};
		fillEth(E);
		/** 同じ判定で出した注文は発注時刻が同じなので、id（発注順）で並べる */
		const orders = () => t.orders().sort((a, b) => a.id.localeCompare(b.id));
		return { ...t, fillEth, orders };
	}

	test("銘柄ごとに判定して買い、注文に銘柄を付け、約定はその銘柄の約定で決める", async () => {
		const t = multi(2);
		expect((await t.call("POST", "/start")).status).toBe(200);
		t.at(T0 + M);
		const placed = t.orders();
		expect(
			placed.map((o) => [o.instrument, o.side, o.quantity, o.status]),
		).toEqual([
			[BTC_JPY.id, "buy", 1_000_000, "open"],
			[ETH_JPY.id, "buy", 20_000, "open"],
		]);
		// 判断は銘柄ごとに記録する
		expect(new Set(placed.map((o) => o.decisionId)).size).toBe(2);

		// ETH の約定では BTC の注文は約定しない
		t.fillEth(E);
		expect(t.orders().map((o) => o.status)).toEqual(["open", "filled"]);
		t.fill(P);
		expect(t.orders().map((o) => o.status)).toEqual(["filled", "filled"]);

		const st = t.status();
		expect(st.instruments.map((i) => i.id)).toEqual([BTC_JPY.id, ETH_JPY.id]);
		expect(st.instrument.id).toBe(BTC_JPY.id);
		expect(st.account.position.quantity).toBe(1_000_000);
		expect(
			st.account.holdings.map((h) => [h.instrument, h.position.quantity]),
		).toEqual([
			[BTC_JPY.id, 1_000_000],
			[ETH_JPY.id, 20_000],
		]);
		// 資産は全銘柄の保有を今の価格で評価する
		expect(st.account.equity).toBe(st.account.cash + 200_000);

		const eth = await t.call(
			"GET",
			`/orders?strategy=${t.strategy.id}&instrument=${ETH_JPY.id}`,
		);
		expect((eth.body.orders as StoredOrder[]).map((o) => o.instrument)).toEqual(
			[ETH_JPY.id],
		);
		const watch = await t.call("GET", `/watch?instrument=${ETH_JPY.id}`);
		expect(watch.status).toBe(200);
		expect((watch.body.instrument as { id: string }).id).toBe(ETH_JPY.id);
		expect(
			(await t.call("GET", "/watch?instrument=coincheck:xrp_jpy")).status,
		).toBe(404);

		const perf = (await t.call("GET", "/performance")).body.performance as Json;
		expect(Object.keys(perf.byInstrument as Json)).toEqual([
			BTC_JPY.id,
			ETH_JPY.id,
		]);
		const summary = t.trading.summaries()[0] as StrategySummary;
		expect(summary.nextMoves?.markets?.map((m) => m.instrument)).toEqual([
			BTC_JPY.id,
			ETH_JPY.id,
		]);
	});

	test("持つ銘柄の数が上限なら、持っていない銘柄は買わない", async () => {
		const t = multi(1);
		await t.call("POST", "/start");
		t.at(T0 + M);
		expect(t.orders().map((o) => o.instrument)).toEqual([BTC_JPY.id]);
		const w = t.trading.watch(t.strategy.id, ETH_JPY.id)?.watch;
		expect(w?.buys[0]?.status).toEqual({
			kind: "blocked",
			reason: "同時に持つ銘柄数の上限 1 に達しているため買わない",
		});
	});

	test("ETH だけの戦略も動かせ、判定時刻は銘柄ごとに持って再起動後も続ける", async () => {
		const t = multi(1, [ETH_JPY.id]);
		await t.call("POST", "/start");
		t.at(T0 + M);
		expect(t.orders().map((o) => [o.instrument, o.quantity])).toEqual([
			[ETH_JPY.id, 20_000],
		]);
		expect(t.status().nextEvalAt).toBe(T0 + 2 * M);
		const restarted = createTradingService({
			repo: new SqliteTradingRepository(t.db),
			strategies: t.strategies,
			judgments: t.judgments,
			calendar: t.calendar,
			dvol: t.dvolRepo,
			marketData: [t.marketDataRepo, t.repoOf(ETH_JPY.id)],
			market: (id) => t.liveOf(id).current,
			fees: TEST_FEE_RATES,
			now: () => t.clock.now,
		});
		expect(restarted.run(t.strategy.id)).toEqual(t.status());
	});
});
