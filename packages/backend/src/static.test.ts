import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createApp } from "./app";
import { serveFrontend } from "./static";

let dir: string;
let server: Hono;

beforeAll(async () => {
	// dir/dist を配信し、その外に dir/secret.txt を置く
	dir = await mkdtemp(join(tmpdir(), "trading-studio-static-"));
	const dist = join(dir, "dist");
	await mkdir(join(dist, "assets"), { recursive: true });
	await writeFile(join(dist, "index.html"), "<html>index</html>");
	await writeFile(join(dist, "assets", "app.js"), "console.log(1)");
	await writeFile(join(dir, "secret.txt"), "secret");
	server = new Hono().route("/", createApp({ isDbReachable: () => true }));
	serveFrontend(server, dist);
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("serveFrontend", () => {
	test("ファイルがあればそのファイルを返す", async () => {
		const res = await server.request("/assets/app.js");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("console.log(1)");
	});

	test("ファイルが無いパスには index.html を返す", async () => {
		const res = await server.request("/backtest/1");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("<html>index</html>");
	});

	test("/api は画面を返さない", async () => {
		expect((await server.request("/api/health")).status).toBe(200);
		expect((await server.request("/api/unknown")).status).toBe(404);
	});

	test("配信ディレクトリの外は返さない", async () => {
		// %2f は Hono のデコード後も残る。ここを / とみなすと dist の外を指す
		const res = await server.request("/..%2fsecret.txt");
		expect(await res.text()).toBe("<html>index</html>");
	});

	test("不正なエンコードでもエラーにしない", async () => {
		const res = await server.request("/%E0");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("<html>index</html>");
	});

	test("画面が未ビルドなら 404 を返す", async () => {
		const empty = new Hono();
		serveFrontend(empty, join(dir, "missing"));
		expect((await empty.request("/")).status).toBe(404);
	});
});
