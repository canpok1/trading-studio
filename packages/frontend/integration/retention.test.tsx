import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { RetentionStatus } from "@trading-studio/backend";
import { setupDom } from "../src/shared/lib/test-setup";
import { createFakeApi, routes } from "./fake-api";
import { renderApp } from "./render-app";

setupDom();

afterEach(async () => {
	await new Promise((r) => setTimeout(r, 20));
	cleanup();
});

function setup(lastRun: RetentionStatus["lastRun"] = null) {
	const status: RetentionStatus = {
		settings: { decisionsDays: 90, backtestsDays: null, marketDataYears: 5 },
		lastRun,
		nextRunAt: Date.UTC(2026, 8, 27, 19),
		running: false,
		dbBytes: 3 * 1024 * 1024,
		freeBytes: 0,
		tables: [],
	};
	const api = createFakeApi()
		.on(routes.api.retention, "$get", () => status)
		.on(routes.api.retention, "$put", (req) => {
			status.settings = req.body as RetentionStatus["settings"];
			return status;
		});
	return renderApp("/settings", api);
}

test("設定の「全般」に保持期間と前回の削除・DB の大きさが出る", async () => {
	const view = setup();
	const decisions = (await view.findByRole("combobox", {
		name: "判断の記録",
	})) as HTMLSelectElement;
	await view.findByText(/まだ削除していない/);
	await waitFor(() => expect(decisions.value).toBe("90"));
	expect(
		(
			view.getByRole("combobox", {
				name: "バックテストの実行",
			}) as HTMLSelectElement
		).value,
	).toBe("null");
	expect(
		(
			view.getByRole("combobox", {
				name: "足・ニュース・採点",
			}) as HTMLSelectElement
		).value,
	).toBe("5");
	expect(view.getByText(/DB の大きさ: 3\.0 MB/)).toBeTruthy();
});

test("保持期間を変えて保存すると送られ、保存後の値が出る", async () => {
	const view = setup();
	const decisions = (await view.findByRole("combobox", {
		name: "判断の記録",
	})) as HTMLSelectElement;
	await waitFor(() => expect(decisions.disabled).toBe(false));
	const card = within(
		decisions.closest("div.flex.flex-col.gap-2\\.5") as HTMLElement,
	);
	const save = card.getByRole("button", { name: "保存" }) as HTMLButtonElement;
	// 変えるまでは保存できない
	expect(save.disabled).toBe(true);
	fireEvent.change(decisions, { target: { value: "180" } });
	fireEvent.click(save);
	await card.findByText(/保存した/);
	expect(view.api.requests.find((r) => r.method === "PUT")?.body).toEqual({
		decisionsDays: 180,
		backtestsDays: null,
		marketDataYears: 5,
	});
	expect(decisions.value).toBe("180");
	expect(save.disabled).toBe(true);
});

test("前回の削除の件数に DVOL の本数が出る", async () => {
	const view = setup({
		at: Date.UTC(2026, 9, 17, 19),
		decisions: 1,
		backtests: 0,
		candles: 2,
		news: 3,
		segments: 0,
		dvol: 1200,
		error: null,
	});
	expect(await view.findByText(/・DVOL 1,200 本/)).toBeTruthy();
});
