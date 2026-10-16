import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type {
	CalendarStatus,
	EventCriteria,
	EventSource,
} from "@trading-studio/backend";
import { changeValue, setupDom } from "../src/shared/lib/test-setup";
import { createFakeApi, routes } from "./fake-api";
import { currentJudgment, newsCollectorStatus } from "./fixtures";
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
		createdAt: 0,
		lastSuccessAt: Date.UTC(2026, 9, 15, 3),
		lastError: null,
		errorSince: null,
		...over,
	};
}

function setup(
	initial: EventSource[],
	status: Partial<CalendarStatus> = {},
	initialCriteria: EventCriteria = {
		versions: [{ version: 1, text: "基準1", note: "初期", createdAt: 0 }],
		activeVersion: 1,
		template: "<event>\n{event}\n</event>\n<criteria>\n{criteria}\n</criteria>",
	},
) {
	let sources = initial;
	let criteria = initialCriteria;
	const api = createFakeApi()
		.on(routes.api.judgments.current, "$get", () =>
			currentJudgment([], Date.now()),
		)
		.on(routes.api.news.status, "$get", () => newsCollectorStatus({}))
		.on(routes.api.calendar.sources, "$get", () => ({ sources }))
		.on(routes.api.calendar.status, "$get", () => ({
			coveredUntil: UNTIL,
			lastRunAt: null,
			nextRunAt: null,
			unjudged: 0,
			...status,
		}))
		.on(routes.api.calendar.sources, "$post", (req, reply) => {
			const body = req.body as Pick<EventSource, "name" | "url">;
			if (!body.url.startsWith("https://"))
				return reply(400, { message: "URL は https://", field: "url" });
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
		})
		.on(routes.api.calendar.criteria, "$get", () => criteria)
		.on(routes.api.calendar.criteria, "$post", (req, reply) => {
			const { text, note } = req.body as { text: string; note: string };
			const v = {
				version: criteria.versions.length + 1,
				text,
				note: note || "画面から編集",
				createdAt: 0,
			};
			criteria = { ...criteria, versions: [...criteria.versions, v] };
			return reply(201, { version: v });
		})
		.on(routes.api.calendar.criteria.active, "$put", (req) => {
			criteria = {
				...criteria,
				activeVersion: (req.body as { version: number }).version,
			};
			return criteria;
		});
	return renderApp("/settings?section=news&tab=events", api);
}

/** 設定画面は要素が多く、画面全体を role で探すと遅いので、ダイアログは属性で探す */
const dialogEl = () => {
	const el = document.querySelector("[role=dialog]");
	if (!el) throw new Error("ダイアログが無い");
	return el as HTMLElement;
};

const card = async (view: ReturnType<typeof setup>, name: string) =>
	within(
		(await view.findByRole("heading", { name })).closest(
			"div.flex.flex-col.gap-2\\.5",
		) as HTMLElement,
	);

test("設定の「ニュース」→「予定」に暦の期間・未判断の件数・取得元と取得の失敗が出る", async () => {
	const view = setup(
		[
			source(),
			source({
				id: 3,
				name: "公式",
				url: "https://b.example/cpi.ics",
				lastError: "取得できない: HTTP 403",
			}),
		],
		{ unjudged: 12 },
	);
	const c = await card(view, "予定の取得元");
	await c.findByText("週次");
	expect(c.getByTestId("calendar-coverage").textContent).toMatch(
		/^暦は .* まで$/,
	);
	expect(c.getByTestId("calendar-unjudged").textContent).toBe(
		"重要度を未判断の予定 12 件（順に判断中）",
	);
	expect(c.getByText("取得できない: HTTP 403")).toBeTruthy();
});

test("今の時刻の暦が無ければ暦切れと出る", async () => {
	const view = setup([], { coveredUntil: null });
	const c = await card(view, "予定の取得元");
	expect((await c.findByTestId("calendar-coverage")).textContent).toBe(
		"暦切れ",
	);
	expect(c.getByText(/取得元が無い/)).toBeTruthy();
});

test("取得元を追加すると名前と URL が送られ、誤りがあれば理由が出る", async () => {
	const view = setup([]);
	const c = await card(view, "予定の取得元");
	await c.findByText(/取得元が無い/);
	fireEvent.click(c.getByRole("button", { name: "取得元を追加" }));
	const dialog = within(dialogEl());
	changeValue(dialog.getByLabelText("名前"), "週次");
	changeValue(dialog.getByLabelText("iCal の URL"), "ftp://a.example/w.ics");
	fireEvent.click(dialog.getByRole("button", { name: "保存する" }));
	await dialog.findByText(/URL は https:\/\//);
	changeValue(
		dialog.getByLabelText("iCal の URL"),
		"https://a.example/week.ics",
	);
	fireEvent.click(dialog.getByRole("button", { name: "保存する" }));
	await c.findByText("まだ取得していない");
	expect(document.querySelector("[role=dialog]")).toBeNull();
	expect(
		view.api.requests.filter((r) => r.method === "POST").at(-1)?.body,
	).toEqual({ name: "週次", url: "https://a.example/week.ics" });
});

test("URL を変えると取り直す旨が出て、変更が送られる。削除は確かめてから行う", async () => {
	const view = setup([source()]);
	const c = await card(view, "予定の取得元");
	fireEvent.click(await c.findByRole("button", { name: "週次 を変更" }));
	const dialog = within(dialogEl());
	expect(dialog.queryByText(/取得した予定を消して取り直す/)).toBeNull();
	changeValue(dialog.getByLabelText("iCal の URL"), "https://c.example/w.ics");
	expect(dialog.getByText(/取得した予定を消して取り直す/)).toBeTruthy();
	fireEvent.click(dialog.getByRole("button", { name: "保存する" }));
	await c.findByText("https://c.example/w.ics");
	expect(view.api.requests.find((r) => r.method === "PUT")?.body).toEqual({
		name: "週次",
		url: "https://c.example/w.ics",
	});

	fireEvent.click(c.getByRole("button", { name: "週次 を削除" }));
	fireEvent.click(
		within(await waitFor(dialogEl)).getByRole("button", {
			name: "削除する",
		}),
	);
	await c.findByText(/取得元が無い/);
});

test("予定の評価基準は編集して新しい版で保存し、「使用する」で切り替える", async () => {
	const view = setup([]);
	const c = await card(view, "予定の評価基準");
	const text = c.getByLabelText("予定の評価基準") as HTMLTextAreaElement;
	expect(text.value).toBe("基準1");
	const save = () => c.getByRole("button", { name: "v2 として保存" });
	expect((save() as HTMLButtonElement).disabled).toBe(true);
	changeValue(text, "基準2");
	changeValue(c.getByLabelText("版の説明（任意）"), "FOMC を重く");
	fireEvent.click(save());
	await c.findByText("v2 を保存した（使用中は v1 のまま）");
	expect(
		view.api.requests.filter((r) => r.method === "POST").at(-1)?.body,
	).toEqual({ text: "基準2", note: "FOMC を重く" });

	fireEvent.click(await c.findByRole("button", { name: "v2 を使用する" }));
	await c.findByText(/v2 を使用中にした/);
	await waitFor(() =>
		expect(
			within(c.getByTestId("event-criteria-v2")).getByText("使用中"),
		).toBeTruthy(),
	);
	expect(view.api.requests.find((r) => r.method === "PUT")?.body).toEqual({
		version: 2,
	});
});
