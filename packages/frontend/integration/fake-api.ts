// 画面のインテグレーションで使う偽物の API。応答は backend の型で検査し、本物との食い違いを型チェックで拾う（docs/adr/0028）
import type { AppType } from "@trading-studio/backend";
import type { InferResponseType } from "hono/client";
import { hc } from "hono/client";
import type { StatusCode } from "hono/utils/http-status";
import type { ApiClient } from "../src/shared/lib/api";

type Method = "$get" | "$post" | "$put" | "$patch" | "$delete";

export type FakeRequest = {
	method: string;
	path: string;
	params: Record<string, string>;
	query: URLSearchParams;
	/** JSON の本文。JSON でなければ文字列、無ければ undefined */
	body: unknown;
};

type Body<F> = F extends (...args: never[]) => Promise<unknown>
	? InferResponseType<F>
	: never;

/** 状態コードを決めて返す。本文は backend がその口・その状態コードで返す型で検査する */
type Reply<F> = <S extends StatusCode>(
	status: S,
	body: F extends (...args: never[]) => Promise<unknown>
		? InferResponseType<F, S>
		: never,
) => Response;

/** 型の付いた本文を返す。状態コードを決めたいときは reply を使う。JSON でない応答（ファイルなど）だけ Response を直に返す */
type Handler<F> = (
	req: FakeRequest,
	reply: Reply<F>,
) => Body<F> | Response | Promise<Body<F> | Response>;

const reply = (status: number, body: unknown) =>
	Response.json(body, { status });

type Route = {
	method: string;
	pattern: RegExp;
	keys: string[];
	handler: (req: FakeRequest, r: typeof reply) => unknown;
};

/** 偽物にする口を指す。`on(routes.api.version, "$get", …)` のように使う。$url は絶対 URL でないと作れないので、パスを取り出すためだけのホストを付ける */
export const routes: ApiClient = hc<AppType>("http://fake.test");

export class FakeApi {
	private routes: Route[] = [];
	/** 受けた要求。送った内容が振る舞いそのもののとき（保存など）に確かめる */
	readonly requests: FakeRequest[] = [];
	/** 登録の無い口への要求（"GET /api/…"）。テストを書くときに、画面が何を読むかを調べるのに使う */
	readonly unhandled: string[] = [];

	/** 同じ口に後から登録したものが優先される */
	on<E, M extends Method & keyof E>(
		endpoint: E,
		method: M,
		handler: Handler<E[M]>,
	): this {
		const url = (endpoint as { $url: () => URL }).$url();
		const path = decodeURIComponent(url.pathname);
		const keys: string[] = [];
		const source = path.replace(/:([^/]+)/g, (_, key: string) => {
			keys.push(key);
			return "([^/]+)";
		});
		this.routes.unshift({
			method: method.slice(1).toUpperCase(),
			pattern: new RegExp(`^${source}$`),
			keys,
			handler: handler as Route["handler"],
		});
		return this;
	}

	/** createApiClient と Playwright の page.route に渡す fetch */
	fetch = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const request = new Request(
			new URL(String(input), "http://fake.test"),
			init,
		);
		const url = new URL(request.url);
		const text = request.body ? await request.text() : "";
		let body: unknown;
		try {
			body = text ? JSON.parse(text) : undefined;
		} catch {
			body = text;
		}
		for (const route of this.routes) {
			if (route.method !== request.method) continue;
			const m = url.pathname.match(route.pattern);
			if (!m) continue;
			const params = Object.fromEntries(
				route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1] ?? "")]),
			);
			const req: FakeRequest = {
				method: request.method,
				path: url.pathname,
				params,
				query: url.searchParams,
				body,
			};
			this.requests.push(req);
			const res = await route.handler(req, reply);
			return res instanceof Response ? res : Response.json(res ?? null);
		}
		this.unhandled.push(`${request.method} ${url.pathname}`);
		return Response.json(
			{ error: `偽物の API に無い: ${request.method} ${url.pathname}` },
			{ status: 404 },
		);
	};
}

/** どの画面でも読み込む口（自動取引の状況・実行中のバックテスト・バージョン）を空で答える偽物 */
export function createFakeApi(): FakeApi {
	return new FakeApi()
		.on(routes.api.trading.runs, "$get", () => ({ runs: [] }))
		.on(routes.api.backtests.current, "$get", () => ({ run: null }))
		.on(routes.api["dataset-runs"].current, "$get", () => ({ run: null }))
		.on(routes.api.version, "$get", () => ({ builtAt: null }));
}
