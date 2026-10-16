import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { CalendarStatus, ListedEvent } from "@trading-studio/backend";
import { setupDom } from "../src/shared/lib/test-setup";
import { createFakeApi, routes } from "./fake-api";
import { renderApp } from "./render-app";

setupDom();

afterEach(async () => {
	await new Promise((r) => setTimeout(r, 20));
	cleanup();
});

const DAY = 24 * 3_600_000;

function event(over: Partial<ListedEvent> & Pick<ListedEvent, "id" | "title">) {
	const start = Date.now() + DAY;
	return {
		description: null,
		start,
		end: start,
		allDay: false,
		sourceName: "週次",
		judgment: null,
		...over,
	} satisfies ListedEvent;
}

function setup(initial: ListedEvent[]) {
	let events = initial;
	const status: CalendarStatus = {
		coveredUntil: Date.now() + 7 * DAY,
		lastRunAt: null,
		nextRunAt: null,
		unjudged: 1,
		failed: 1,
	};
	const api = createFakeApi()
		.on(routes.api.calendar.events, "$get", (req) => {
			const min = req.query.get("minImportance");
			const list = events.filter(
				(e) =>
					min !== "high" ||
					e.judgment?.status !== "done" ||
					e.judgment.importance === "high",
			);
			return { version: 2, events: list, total: list.length };
		})
		.on(routes.api.calendar.status, "$get", () => status)
		.on(routes.api.calendar.events[":id"].judge, "$post", (req) => {
			events = events.map((e) =>
				String(e.id) === req.params.id
					? {
							...e,
							judgment: {
								status: "pending",
								attempts: 0,
								error: null,
								nextAttemptAt: null,
							},
						}
					: e,
			);
			return { ok: true as const };
		});
	return renderApp("/news?tab=events", api);
}

const rows = (view: ReturnType<typeof setup>) => view.queryAllByTestId("event");

test("ニュース画面の「予定」のタブに、予定と重要度・理由・判断の状態が並ぶ", async () => {
	const view = setup([
		event({
			id: 1,
			title: "US CPI",
			judgment: {
				status: "done",
				importance: "high",
				reason: "米 CPI は BTC/JPY を大きく動かす",
				judgedAt: 0,
				model: "m",
			},
		}),
		event({ id: 2, title: "Bank Holiday" }),
		event({
			id: 3,
			title: "US ISM",
			judgment: { status: "failed", attempts: 4, error: "HTTP 429" },
		}),
	]);
	await waitFor(() => expect(rows(view)).toHaveLength(3));
	expect(view.getByRole("tab", { name: "予定", selected: true })).toBeTruthy();
	const [cpi, holiday, ism] = rows(view).map((r) => within(r));
	expect(cpi?.getByText("重要度 高")).toBeTruthy();
	expect(cpi?.getByText("米 CPI は BTC/JPY を大きく動かす")).toBeTruthy();
	expect(holiday?.getByText("判断待ち")).toBeTruthy();
	expect(ism?.getByText(/判断に失敗（HTTP 429）/)).toBeTruthy();
	expect(view.getByTestId("events-summary").textContent).toMatch(
		/^v2 で判断 · 暦は .* まで · 未判断 1 件 · 失敗 1 件 · 3 件$/,
	);
});

test("重要度で絞ると、判断済みで低い予定を除いて問い合わせる", async () => {
	const view = setup([
		event({
			id: 1,
			title: "US CPI",
			judgment: {
				status: "done",
				importance: "high",
				reason: "r",
				judgedAt: 0,
				model: "m",
			},
		}),
		event({
			id: 2,
			title: "Bank Holiday",
			judgment: {
				status: "done",
				importance: "low",
				reason: "r",
				judgedAt: 0,
				model: "m",
			},
		}),
	]);
	await waitFor(() => expect(rows(view)).toHaveLength(2));
	fireEvent.change(view.getByLabelText("重要度"), {
		target: { value: "high" },
	});
	await waitFor(() => expect(rows(view)).toHaveLength(1));
	expect(view.location.current).toContain("min=high");
});

test("判断に失敗した予定は「詳しく」から判断し直せる。判断済みの予定には出さない", async () => {
	const view = setup([
		event({
			id: 7,
			title: "US CPI",
			description: "Impact: High",
			judgment: { status: "failed", attempts: 4, error: "HTTP 429" },
		}),
		event({
			id: 8,
			title: "US ISM",
			judgment: {
				status: "done",
				importance: "high",
				reason: "r",
				judgedAt: 0,
				model: "m",
			},
		}),
	]);
	await waitFor(() => expect(rows(view)).toHaveLength(2));
	expect(
		within(rows(view)[1] as HTMLElement).queryByRole("button", {
			name: "v2 で判断し直す",
		}),
	).toBeNull();
	const row = within(rows(view)[0] as HTMLElement);
	expect(row.getByText("Impact: High")).toBeTruthy();
	fireEvent.click(row.getByRole("button", { name: "v2 で判断し直す" }));
	await waitFor(() =>
		expect(
			within(rows(view)[0] as HTMLElement).getByText("判断待ち"),
		).toBeTruthy(),
	);
	expect(view.api.requests.find((r) => r.method === "POST")?.body).toEqual({
		version: 2,
	});
});
