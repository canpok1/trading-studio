import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { CalendarStatus, EventSource } from "@trading-studio/backend";
import { changeValue, setupDom } from "../src/shared/lib/test-setup";
import { createFakeApi, routes } from "./fake-api";
import { renderApp } from "./render-app";

setupDom();

afterEach(async () => {
	await new Promise((r) => setTimeout(r, 20));
	cleanup();
});

const UNTIL = Date.UTC(2026, 11, 31, 15);

function source(over: Partial<EventSource> = {}): EventSource {
	return {
		id: 1,
		name: "週次",
		url: "https://a.example/week.ics",
		keywords: { cpi: "US CPI m/m", boj: "BOJ" },
		createdAt: 0,
		lastSuccessAt: Date.UTC(2026, 9, 15, 3),
		lastError: null,
		errorSince: null,
		stale: [],
		...over,
	};
}

function setup(initial: EventSource[]) {
	let sources = initial;
	const status: CalendarStatus = {
		coveredUntil: [
			{ type: "fomc", until: UNTIL },
			{ type: "fomcMinutes", until: UNTIL },
			{ type: "cpi", until: UNTIL },
			{ type: "nfp", until: null },
			{ type: "boj", until: UNTIL },
		],
		lastRunAt: null,
		nextRunAt: null,
	};
	const api = createFakeApi()
		.on(routes.api.calendar.sources, "$get", () => ({ sources }))
		.on(routes.api.calendar.status, "$get", () => status)
		.on(routes.api.calendar.sources, "$post", (req, reply) => {
			const body = req.body as Pick<EventSource, "name" | "url" | "keywords">;
			if (!body.keywords.cpi)
				return reply(400, {
					message: "1つ以上の種類に語を入れる",
					field: "keywords",
				});
			const s = source({ ...body, id: 2, lastSuccessAt: null });
			sources = [...sources, s];
			return reply(201, { source: s });
		})
		.on(routes.api.calendar.sources[":id"], "$put", (req) => {
			const s = { ...source(), ...(req.body as Partial<EventSource>) };
			sources = sources.map((x) => (String(x.id) === req.params.id ? s : x));
			return { source: s };
		})
		.on(routes.api.calendar.sources[":id"], "$delete", (req) => {
			sources = sources.filter((s) => String(s.id) !== req.params.id);
			return { ok: true as const };
		});
	return renderApp("/settings", api);
}

/** 設定画面は要素が多く、画面全体を role で探すと遅いので、ダイアログは属性で探す */
const dialogEl = () => {
	const el = document.querySelector("[role=dialog]");
	if (!el) throw new Error("ダイアログが無い");
	return el as HTMLElement;
};

const card = async (view: ReturnType<typeof setup>) =>
	within(
		(await view.findByRole("heading", { name: "予定イベントの暦" })).closest(
			"div.flex.flex-col.gap-2\\.5",
		) as HTMLElement,
	);

test("設定の「全般」に種類ごとの暦の期間と取得元・取得の失敗・拾えていない種類が出る", async () => {
	const view = setup([
		source(),
		source({
			id: 3,
			name: "公式",
			url: "https://b.example/cpi.ics",
			lastError: "取得できない: HTTP 403",
			stale: ["cpi"],
		}),
	]);
	const c = await card(view);
	await c.findByText("週次");
	expect(c.getByText("暦切れ")).toBeTruthy();
	expect(c.getAllByText(/まで$/)).toHaveLength(4);
	expect(c.getAllByText("米 CPI「US CPI m/m」・日銀会合「BOJ」")).toHaveLength(
		2,
	);
	expect(c.getByText("取得できない: HTTP 403")).toBeTruthy();
	expect(c.getByText(/米 CPIが 70 日拾えていない/)).toBeTruthy();
});

test("取得元を追加すると入れた語が送られ、語が無ければ理由が出る", async () => {
	const view = setup([]);
	const c = await card(view);
	await c.findByText(/取得元が無い/);
	fireEvent.click(c.getByRole("button", { name: "取得元を追加" }));
	const dialog = within(dialogEl());
	changeValue(dialog.getByLabelText("名前"), "週次");
	changeValue(
		dialog.getByLabelText("iCal の URL"),
		"https://a.example/week.ics",
	);
	fireEvent.click(dialog.getByRole("button", { name: "保存する" }));
	await dialog.findByText(/1つ以上の種類に語を入れる/);
	changeValue(dialog.getByLabelText("米 CPI"), "US CPI m/m");
	fireEvent.click(dialog.getByRole("button", { name: "保存する" }));
	await c.findByText("まだ取得していない");
	expect(document.querySelector("[role=dialog]")).toBeNull();
	expect(
		view.api.requests.filter((r) => r.method === "POST").at(-1)?.body,
	).toEqual({
		name: "週次",
		url: "https://a.example/week.ics",
		keywords: { cpi: "US CPI m/m" },
	});
});

test("語を変えると取り直す旨が出て、変更が送られる。削除は確かめてから行う", async () => {
	const view = setup([source()]);
	const c = await card(view);
	fireEvent.click(await c.findByRole("button", { name: "週次 を変更" }));
	const dialog = within(dialogEl());
	expect(dialog.queryByText(/取得した暦を消して取り直す/)).toBeNull();
	changeValue(dialog.getByLabelText("日銀会合"), "");
	expect(dialog.getByText(/取得した暦を消して取り直す/)).toBeTruthy();
	fireEvent.click(dialog.getByRole("button", { name: "保存する" }));
	await c.findByText("米 CPI「US CPI m/m」");
	expect(document.querySelector("[role=dialog]")).toBeNull();
	expect(view.api.requests.find((r) => r.method === "PUT")?.body).toEqual({
		name: "週次",
		url: "https://a.example/week.ics",
		keywords: { cpi: "US CPI m/m", boj: "" },
	});

	fireEvent.click(c.getByRole("button", { name: "週次 を削除" }));
	fireEvent.click(
		within(await waitFor(dialogEl)).getByRole("button", {
			name: "削除する",
		}),
	);
	await c.findByText(/取得元が無い/);
});
