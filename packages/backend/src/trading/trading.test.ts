import { describe, expect, test } from "bun:test";
import type { ConditionSet, MarketTrade } from "@trading-studio/core";
import { MARKET_BUY_ORDER, strategyTemplate } from "@trading-studio/core";
import { createTestApp } from "../test-app";
import { TradingRepository } from "./repository";
import { createTradingService } from "./service";
import type { AutoTradingStatus, StoredOrder } from "./types";

const M = 60_000;
const T0 = 1_800_000_000_000; // 分の区切り
const P = 10_000_000;

type Json = Record<string, unknown>;

/** 1分ごとに評価し、いつでも買い、買値から1%動いたら売る戦略 */
const always = (over: Partial<ConditionSet> = {}): ConditionSet => ({
	...strategyTemplate("trend").params,
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

function setup(params: ConditionSet = always()) {
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
	const s = t.strategies.create({ name: "常に買う", from: { params } });
	if (!s.ok) throw new Error(JSON.stringify(s.error));
	t.trading.update(1, { strategyId: s.strategy.id });
	/** 最初のタブ（id 1）の操作は /start のように書ける */
	const call = async (method: string, path: string, body?: unknown) => {
		const url = /^\/(start|stop|reset|performance)/.test(path)
			? `/runs/1${path}`
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
		t.trading.onTrades([tr]);
	};
	const orders = () =>
		t.trading.orders({}).sort((a, b) => a.placedAt - b.placedAt);
	const status = () => t.trading.run(1) as AutoTradingStatus;
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
		{ scores: { sentiment: null, risk: null }, comment: "c" },
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
		expect(st.strategy?.name).toBe("常に買う");
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
			risk: "normal",
		});
		expect(detail?.decision?.decision.time).toBe(T0 + M);
		const api = await t.call("GET", "/orders/1/p1");
		expect(api.body).toMatchObject({
			order: { id: "p1", runId: 1, mode: "paper" },
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

	test("ライブは動かせず、運用する戦略が無いか条件が足りなければオンにできない", async () => {
		const t = setup();
		const live = t.trading.create({
			name: "ライブ",
			mode: "live",
			strategyId: t.strategy.id,
		});
		if (!live.ok) throw new Error();
		expect(
			(await t.call("POST", `/runs/${live.status.id}/start`)).body.kind,
		).toBe("unsupported_mode");
		t.strategies.updateParams(t.strategy.id, always());
		const blank = t.strategies.create({
			name: "空",
			from: { template: "blank" },
		});
		if (!blank.ok) throw new Error();
		t.trading.update(1, { strategyId: blank.strategy.id });
		const r = await t.call("POST", "/start");
		expect(r.status).toBe(400);
		expect(r.body.kind).toBe("invalid_strategy");
		t.trading.update(1, { strategyId: null });
		expect((await t.call("POST", "/start")).body.kind).toBe("no_strategy");
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
		expect(await ids("run=1")).toEqual(["p2", "p1"]);
		expect(await ids("run=1&limit=1")).toEqual(["p2"]);
		expect(await ids("side=buy&status=filled")).toEqual(["p1"]);
		expect(await ids("run=2")).toEqual([]);
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
			repo: new TradingRepository(t.db),
			strategies: t.strategies,
			judgments: {
				current: () => {
					throw new Error("約定だけなので判定は使わない");
				},
			},
			marketData: t.marketDataRepo,
			market: () => t.live.current,
			now: () => t.clock.now,
		});
		expect(restarted.run(1)).toEqual(before);
		const tr: MarketTrade = {
			id: 99,
			time: t.clock.now,
			price: 9_000_000,
			quantity: 1,
		};
		restarted.onTrades([tr]);
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
	test("オン中は運用する戦略を変えられず、動かしている戦略が消えたら止まる", async () => {
		const t = setup();
		await t.call("POST", "/start");
		expect(
			(await t.call("PATCH", "/runs/1", { strategyId: null })).status,
		).toBe(409);
		t.strategies.remove(t.strategy.id);
		t.at(T0 + M);
		expect(t.status().enabled).toBe(false);
	});

	test("オン中と保有がある間は、運用する戦略の切り替え・条件の変更・削除ができない。ほかの戦略は変えられる", async () => {
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
		const blocked = async () => {
			expect(
				(await t.call("PATCH", "/runs/1", { strategyId: null })).status,
			).toBe(409);
			expect(await req("PUT", `/${id}/params`, { params: always() })).toBe(409);
			expect(await req("DELETE", `/${id}`)).toBe(409);
		};
		const other = t.strategies.create({
			name: "別",
			from: { params: always() },
		});
		if (!other.ok) throw new Error();

		await t.call("POST", "/start");
		expect(t.status().strategyLock).toBe("running");
		await blocked();
		// 名前の変更とほかの戦略の変更はできる
		expect(await req("PUT", `/${id}/name`, { name: "改名" })).toBe(200);
		expect(
			await req("PUT", `/${other.strategy.id}/params`, { params: always() }),
		).toBe(200);

		t.at(T0 + M);
		t.fill(P);
		await t.call("POST", "/stop");
		expect(t.status().strategyLock).toBe("holding");
		await blocked();

		expect(
			(await t.call("POST", "/reset", { initialCash: 100_000_000 })).status,
		).toBe(200);
		expect(t.status().strategyLock).toBe(null);
		expect(await req("PUT", `/${id}/params`, { params: always() })).toBe(200);
		expect(
			(await t.call("PATCH", "/runs/1", { strategyId: other.strategy.id }))
				.status,
		).toBe(200);
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
		expect((await t.call("GET", "/runs/9/performance")).status).toBe(404);
	});
});

describe("複数ポジション", () => {
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
		t.db.$client.run("update trading_runs set account = ? where id = ?", [
			JSON.stringify({
				cash: 900_000,
				position: { quantity: 1_000_000, entryPrice: P, openedAt: T0 },
				entry: { record: { id: "p1" }, time: T0, cost: 100_100 },
				openOrders: [],
				seq: 1,
			}),
			1,
		]);
		expect(t.status().account.lots).toEqual([
			{
				id: "p1",
				quantity: 1_000_000,
				entryPrice: P,
				openedAt: T0,
				partialExitDone: false,
			},
		]);
	});
});

describe("複数のタブ", () => {
	test("タブごとに口座・注文・オンオフを持ち、別々に動く", async () => {
		const t = setup();
		const r = await t.call("POST", "/runs", {
			name: "比較用",
			mode: "paper",
			strategyId: t.strategy.id,
		});
		expect(r.status).toBe(201);
		const second = (r.body.status as AutoTradingStatus).id;
		await t.call("POST", `/runs/${second}/reset`, { initialCash: 500_000 });
		await t.call("POST", "/start");
		await t.call("POST", `/runs/${second}/start`);
		t.at(T0 + M);
		t.fill(P);
		// どちらのタブも買い、注文の id はタブの中で振る
		expect(t.orders().map((o) => [o.runId, o.id, o.status])).toEqual([
			[1, "p1", "filled"],
			[second, "p1", "filled"],
		]);
		expect(t.trading.run(second)?.account.cash).toBe(500_000 - 100_100);
		expect(t.status().account.cash).toBe(1_000_000 - 100_100);
		expect((await t.call("GET", `/orders?run=${second}`)).body.count).toBe(1);
		expect(t.trading.order(second, "p1")?.order.runId).toBe(second);

		// 片方を止めても、もう片方は動き続ける
		await t.call("POST", "/stop");
		t.fill(10_200_000);
		t.at(T0 + 2 * M);
		t.fill(10_200_000);
		expect(t.trading.run(second)?.account.lots).toEqual([]);
		expect(t.status().account.lots).toHaveLength(1);
		expect(
			(await t.call("GET", "/runs")).body.runs as AutoTradingStatus[],
		).toMatchObject([
			{ id: 1, name: "ペーパー", enabled: false },
			{ id: second, name: "比較用", enabled: true },
		]);
	});

	test("1つのタブの口座が読めなくても、ほかのタブは約定・評価を続ける", async () => {
		const t = setup();
		const broken = t.trading.create({
			name: "壊れた",
			mode: "paper",
			strategyId: t.strategy.id,
		});
		if (!broken.ok) throw new Error();
		t.db.$client.run("update trading_runs set account = '{' where id = ?", [
			broken.status.id,
		]);
		await t.call("POST", "/start");
		t.at(T0 + M);
		t.fill(P);
		expect(t.orders().map((o) => [o.runId, o.status])).toEqual([[1, "filled"]]);
	});

	test("タブは5つまで、ライブは1つまで。名前は必須", async () => {
		const t = setup();
		const add = (mode: "paper" | "live", name = "x") =>
			t.trading.create({ name, mode, strategyId: null });
		expect(add("paper", " ")).toMatchObject({
			ok: false,
			error: { kind: "invalid_name" },
		});
		expect(add("live").ok).toBe(true);
		expect(add("live")).toMatchObject({ ok: false, error: { kind: "limit" } });
		expect(add("paper").ok).toBe(true);
		expect(add("paper").ok).toBe(true);
		expect(add("paper").ok).toBe(true);
		expect(t.trading.runs()).toHaveLength(5);
		expect(
			(
				await t.call("POST", "/runs", {
					name: "x",
					mode: "paper",
					strategyId: null,
				})
			).status,
		).toBe(409);
	});

	test("名前を変えられる。タブはオフのときだけ消せ、未約定は取り消して記録は残す。最後の1つは消せない", async () => {
		const t = setup(
			always({
				buyOrder: {
					lines: [{ type: "limit", belowPercent: 5 }],
					expireBars: 100,
					expireTimeframe: "1m",
				},
			}),
		);
		const created = t.trading.create({
			name: "消す",
			mode: "paper",
			strategyId: t.strategy.id,
		});
		if (!created.ok) throw new Error();
		const id = created.status.id;
		expect(
			(await t.call("PATCH", `/runs/${id}`, { name: "改名" })).body,
		).toMatchObject({ status: { name: "改名" } });
		await t.call("POST", `/runs/${id}/start`);
		t.at(T0 + M);
		expect((await t.call("DELETE", `/runs/${id}`)).status).toBe(409);
		await t.call("POST", `/runs/${id}/stop`);
		expect((await t.call("DELETE", `/runs/${id}`)).status).toBe(200);
		expect(t.trading.runs().map((r) => r.id)).toEqual([1]);
		expect(t.orders()).toMatchObject([
			{ runId: id, status: "canceled", cancelReason: "タブの削除で取消" },
		]);
		expect((await t.call("DELETE", "/runs/1")).status).toBe(409);
		expect((await t.call("POST", `/runs/${id}/start`)).status).toBe(404);
	});

	test("戦略は、その戦略を使うタブのどれかがオンか保有がある間だけ変えられない", async () => {
		const t = setup();
		const other = t.trading.create({
			name: "同じ戦略",
			mode: "paper",
			strategyId: t.strategy.id,
		});
		if (!other.ok) throw new Error();
		expect(t.trading.strategyLock(t.strategy.id)).toBe(null);
		await t.call("POST", `/runs/${other.status.id}/start`);
		expect(t.trading.strategyLock(t.strategy.id)).toBe("running");
		// 止めているタブは、オンのタブと同じ戦略でも切り替えられる
		expect(t.trading.update(1, { strategyId: null }).ok).toBe(true);
		expect(
			(
				await t.app.request(`/api/strategies/${t.strategy.id}`, {
					method: "DELETE",
				})
			).status,
		).toBe(409);
	});
});
