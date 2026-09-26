import { describe, expect, test } from "bun:test";
import type { ConditionSet, MarketTrade } from "@trading-studio/core";
import { DEFAULT_BUY_ORDER, strategyTemplate } from "@trading-studio/core";
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
	timeframe: "1m",
	frequency: {
		flat: { value: 1, unit: "m" },
		holding: { value: 1, unit: "m" },
	},
	orderSize: 1_000_000,
	buy: {
		match: "all",
		conditions: [
			{ type: "judgment", judge: "trend", values: ["up", "range", "down"] },
		],
	},
	buyOrder: { ...DEFAULT_BUY_ORDER, type: "market" },
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
	t.strategies.setActive(s.strategy.id);
	const call = async (method: string, path: string, body?: unknown) => {
		const res = await t.app.request(`/api/trading${path}`, {
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
	const status = () => t.trading.status();
	return { ...t, strategy: s.strategy, call, at, fill, orders, status };
}

describe("自動取引のオンオフ", () => {
	test("オンにすると戦略の粒度の次の足の終わりに評価し、条件どおりに仮想注文を出す", async () => {
		const t = setup();
		const started = await t.call("POST", "/start", { mode: "paper" });
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
		const detail = t.trading.order("paper", "p1");
		expect(detail?.decision?.judgments).toEqual({ trend: "range" });
		expect(detail?.decision?.decision.time).toBe(T0 + M);
	});

	test("ライブは選べず、運用する戦略が無いか条件が足りなければオンにできない", async () => {
		const t = setup();
		expect((await t.call("POST", "/start", { mode: "live" })).status).toBe(400);
		t.strategies.updateParams(t.strategy.id, always());
		const blank = t.strategies.create({
			name: "空",
			from: { template: "blank" },
		});
		if (!blank.ok) throw new Error();
		t.strategies.setActive(blank.strategy.id);
		const r = await t.call("POST", "/start", { mode: "paper" });
		expect(r.status).toBe(400);
		expect(r.body.kind).toBe("invalid_strategy");
		t.strategies.setActive(null);
		expect((await t.call("POST", "/start", { mode: "paper" })).body.kind).toBe(
			"no_strategy",
		);
	});

	test("オフにすると新しい注文を出さず、未約定の注文は残る", async () => {
		const t = setup(
			always({
				buyOrder: {
					type: "limit",
					belowPercent: 1,
					expireBars: 10,
				},
			}),
		);
		await t.call("POST", "/start", { mode: "paper" });
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
		await t.call("POST", "/start", { mode: "paper" });
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
	});

	test("指値は指値以下の約定が来たら指値で約定し、跨がなければ約定しない", async () => {
		const t = setup(
			always({ buyOrder: { type: "limit", belowPercent: 1, expireBars: 3 } }),
		);
		await t.call("POST", "/start", { mode: "paper" });
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

	test("指値は戦略の粒度の足 M 本ぶんの時間が過ぎたら取り消す", async () => {
		const t = setup(
			always({ buyOrder: { type: "limit", belowPercent: 1, expireBars: 3 } }),
		);
		await t.call("POST", "/start", { mode: "paper" });
		t.at(T0 + M);
		await t.call("POST", "/stop");
		t.at(T0 + 4 * M - 1);
		expect(t.orders()[0]?.status).toBe("open");
		t.at(T0 + 4 * M);
		expect(t.orders()[0]).toMatchObject({
			status: "canceled",
			cancelReason: "指値 9,900,000 が 3 本のあいだ約定しなかったため取消",
		});
	});

	test("成行の買いは約定時に手数料込みの額が足りなければ取り消す", async () => {
		const t = setup();
		await t.call("POST", "/reset", { initialCash: 100_000 });
		await t.call("POST", "/start", { mode: "paper" });
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
			always({ buyOrder: { type: "limit", belowPercent: 1, expireBars: 100 } }),
		);
		await t.call("POST", "/start", { mode: "paper" });
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
			always({ buyOrder: { type: "limit", belowPercent: 1, expireBars: 100 } }),
		);
		await t.call("POST", "/start", { mode: "paper" });
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
		expect(restarted.status()).toEqual(before);
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
			always({ buyOrder: { type: "limit", belowPercent: 1, expireBars: 100 } }),
		);
		await t.call("POST", "/start", { mode: "paper" });
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
		await t.call("POST", "/start", { mode: "paper" });
		t.at(T0 + 2 * M);
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
		await t.call("POST", "/start", { mode: "paper" });
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
		await t.call("POST", "/start", { mode: "paper" });
		const res = await t.app.request("/api/strategies/active", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: null }),
		});
		expect(res.status).toBe(409);
		t.strategies.remove(t.strategy.id);
		t.at(T0 + M);
		expect(t.status().enabled).toBe(false);
	});
});
