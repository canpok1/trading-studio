import { describe, expect, test } from "bun:test";
import { strategyTemplate } from "@trading-studio/core";
import { createTestApp } from "../test-app";
import type { StoredStrategy } from "./types";

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

		const params = { ...s.params, orderSize: 3_000_000 };
		const saved = await call(app, "PUT", `/${s.id}/params`, { params });
		expect(saved.status).toBe(200);
		const got = await call(app, "GET", `/${s.id}`);
		expect((got.body.strategy as StoredStrategy).params.orderSize).toBe(
			3_000_000,
		);
	});

	test("入力に誤りのある条件は保存しない", async () => {
		const { app } = createTestApp();
		const s = (
			await call(app, "POST", "", { name: "a", from: { template: "blank" } })
		).body.strategy as StoredStrategy;
		const r = await call(app, "PUT", `/${s.id}/params`, { params: s.params });
		expect(r.status).toBe(400);
		expect(r.body.errors).toEqual([
			{ path: "buy", message: "買い注文の条件を1つ以上追加する" },
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
		const { app } = createTestApp();
		const a = (
			await call(app, "POST", "", { name: "a", from: { template: "range" } })
		).body.strategy as StoredStrategy;
		const copy = (
			await call(app, "POST", "", {
				name: "a のコピー",
				from: { copyOf: a.id },
			})
		).body.strategy as StoredStrategy;
		expect(copy.params).toEqual(a.params);
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
