import { describe, expect, test } from "bun:test";
import { ETH_JPY, strategyTemplate, XRP_JPY } from "@trading-studio/core";
import { createTestDb } from "../src/db/test-db-infra";
import type { StoredStrategy } from "../src/strategies/types-domain";
import { createTestApp } from "./test-app";

type Json = Record<string, unknown>;

async function call(
	app: ReturnType<typeof createTestApp>["app"],
	method: string,
	path: string,
	body?: unknown,
) {
	const res = await app.request(`/api/strategies${path}`, {
		method,
		headers: body ? { "content-type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
	});
	return { status: res.status, body: (await res.json()) as Json };
}

describe("戦略の API", () => {
	test("ひな形から作り、条件を変えて保存すると、読み直しても残っている", async () => {
		const { app } = createTestApp();
		const created = await call(app, "POST", "", {
			name: " トレンド ",
			from: { template: "trend" },
		});
		expect(created.status).toBe(201);
		const s = created.body.strategy as StoredStrategy;
		expect(s.name).toBe("トレンド");
		expect(s.params).toEqual(strategyTemplate("trend").params);

		const params = {
			...s.params,
			buys: s.params.buys.map((b) => ({ ...b, orderSize: 3_000_000 })),
		};
		const saved = await call(app, "PUT", `/${s.id}/params`, { params });
		expect(saved.status).toBe(200);
		const got = await call(app, "GET", `/${s.id}`);
		expect(
			(got.body.strategy as StoredStrategy).params.buys[0]?.orderSize,
		).toBe(3_000_000);
	});

	test("入力に誤りのある条件は保存しない", async () => {
		const { app } = createTestApp();
		const s = (
			await call(app, "POST", "", { name: "a", from: { template: "blank" } })
		).body.strategy as StoredStrategy;
		const r = await call(app, "PUT", `/${s.id}/params`, { params: s.params });
		expect(r.status).toBe(400);
		expect(r.body.errors).toEqual([
			{ path: "buys.0.buy", message: "買い注文の条件を1つ以上追加する" },
		]);
	});

	test("同じ名前は付けられない（作成・リネームとも）", async () => {
		const { app } = createTestApp();
		await call(app, "POST", "", { name: "a", from: { template: "trend" } });
		const b = (
			await call(app, "POST", "", { name: "b", from: { template: "trend" } })
		).body.strategy as StoredStrategy;
		expect(
			(await call(app, "POST", "", { name: "a", from: { template: "range" } }))
				.status,
		).toBe(409);
		expect(
			(await call(app, "PUT", `/${b.id}/name`, { name: "a" })).status,
		).toBe(409);
		expect(
			(await call(app, "PUT", `/${b.id}/name`, { name: " " })).status,
		).toBe(400);
		// 自分と同じ名前へのリネームは通す
		expect(
			(await call(app, "PUT", `/${b.id}/name`, { name: "b" })).status,
		).toBe(200);
	});

	test("複製・リネーム・削除", async () => {
		const db = createTestDb();
		const { app } = createTestApp({}, db);
		const a = (
			await call(app, "POST", "", { name: "a", from: { template: "range" } })
		).body.strategy as StoredStrategy;
		// 作った戦略は BTC/JPY の1銘柄を対象にする
		expect(a).toMatchObject({
			market: "coincheck",
			instruments: ["coincheck:btc_jpy"],
		});
		// 複製は元の対象を引き継ぐ（既定と区別するため元を書き換えておく）
		const instruments = ["coincheck:btc_jpy", "coincheck:eth_jpy"];
		db.$client.run("update strategies set instruments = ? where id = ?", [
			JSON.stringify(instruments),
			a.id,
		]);
		const copy = (
			await call(app, "POST", "", {
				name: "a のコピー",
				from: { copyOf: a.id },
			})
		).body.strategy as StoredStrategy;
		expect(copy.params).toEqual(a.params);
		expect(copy).toMatchObject({ market: "coincheck", instruments });
		const renamed = await call(app, "PUT", `/${a.id}/name`, {
			name: "新しい名前",
		});
		expect((renamed.body.strategy as StoredStrategy).name).toBe("新しい名前");
		expect((await call(app, "DELETE", `/${a.id}`)).status).toBe(200);
		expect((await call(app, "GET", `/${a.id}`)).status).toBe(404);
		const list = (await call(app, "GET", "")).body
			.strategies as StoredStrategy[];
		expect(list.map((s) => s.name)).toEqual(["a のコピー"]);
	});

	test("候補の銘柄を条件と一緒に保存し、省くと今の候補のまま。検証を通らない候補は保存しない", async () => {
		const { app } = createTestApp();
		const s = (
			await call(app, "POST", "", { name: "a", from: { template: "trend" } })
		).body.strategy as StoredStrategy;
		expect(s.instruments).toEqual(["coincheck:btc_jpy"]);
		const ids = ["coincheck:btc_jpy", ETH_JPY.id, XRP_JPY.id];
		const byAmount = {
			...s.params,
			buys: s.params.buys.map((b) => ({ ...b, orderAmount: 100_000 })),
			maxHoldings: 2,
		};
		// BTC/JPY 以外を含むなら金額で注文する
		const bad = await call(app, "PUT", `/${s.id}/params`, {
			params: s.params,
			instruments: ids,
		});
		expect(bad.status).toBe(400);
		expect(bad.body.errors).toEqual([
			{
				path: "instruments",
				message: "銘柄ごとに価格と数量の単位が違うので、注文量を金額で入れる",
			},
		]);
		const saved = await call(app, "PUT", `/${s.id}/params`, {
			params: byAmount,
			instruments: ids,
		});
		expect(saved.status).toBe(200);
		expect((saved.body.strategy as StoredStrategy).instruments).toEqual(ids);
		const again = await call(app, "PUT", `/${s.id}/params`, {
			params: byAmount,
		});
		expect((again.body.strategy as StoredStrategy).instruments).toEqual(ids);
		// 価格を集めていない銘柄は形の誤り
		expect(
			(
				await call(app, "PUT", `/${s.id}/params`, {
					params: byAmount,
					instruments: ["coincheck:doge_jpy"],
				})
			).status,
		).toBe(400);
	});

	test("形の違う入力は 400", async () => {
		const { app } = createTestApp();
		expect(
			(await call(app, "POST", "", { name: "a", from: { template: "nope" } }))
				.status,
		).toBe(400);
		expect(
			(await call(app, "POST", "", { name: "a", from: { copyOf: 99 } })).status,
		).toBe(404);
	});
});
