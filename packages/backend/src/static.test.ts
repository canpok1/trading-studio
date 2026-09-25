import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { app } from "./app";
import { serveFrontend } from "./static";

let dir: string;
let server: Hono;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "trading-studio-static-"));
	await writeFile(join(dir, "index.html"), "<html>index</html>");
	await mkdir(join(dir, "assets"));
	await writeFile(join(dir, "assets", "app.js"), "console.log(1)");
	server = new Hono().route("/", app);
	serveFrontend(server, dir);
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
		const res = await server.request("/%2e%2e/%2e%2e/etc/passwd");
		expect(await res.text()).toBe("<html>index</html>");
	});
});
