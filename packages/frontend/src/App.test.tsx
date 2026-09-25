import "./test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { App } from "./App";
import { createApiClient } from "./api";

afterEach(cleanup);

function fakeFetch(response: () => Promise<Response>): typeof fetch {
	return Object.assign(() => response(), { preconnect: () => {} });
}

describe("App", () => {
	test("health の結果を表示する", async () => {
		const client = createApiClient(
			fakeFetch(async () => Response.json({ status: "ok" })),
		);
		const view = render(<App client={client} />);
		expect(await view.findByText("health: ok")).toBeTruthy();
	});

	test("エラー時はエラーを表示する", async () => {
		const client = createApiClient(
			fakeFetch(async () => new Response("", { status: 500 })),
		);
		const view = render(<App client={client} />);
		expect((await view.findByRole("alert")).textContent).toContain("HTTP 500");
	});
});
