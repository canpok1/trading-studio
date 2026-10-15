import { describe, expect, test } from "bun:test";
import { calendarGap, EVENT_CALENDAR_RANGE } from "@trading-studio/core";
import type { EventSource } from "../src/calendar/types-domain";
import { createTestApp } from "./test-app";

const H = 3_600_000;
const D = 24 * H;
/** リポジトリに持つ暦の終わり（2027-01-01 0:00 JST） */
const END = EVENT_CALENDAR_RANGE.until;
const URL_A = "https://a.example/week.ics";

function setup() {
	const t = createTestApp();
	const send = (method: string, path: string, body?: unknown) =>
		t.app.request(`/api/calendar${path}`, {
			method,
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const add = async (body: unknown) => {
		const res = await send("POST", "/sources", body);
		return {
			status: res.status,
			body: (await res.json()) as Record<string, unknown>,
		};
	};
	const sources = async () =>
		(
			(await (await send("GET", "/sources")).json()) as {
				sources: EventSource[];
			}
		).sources;
	return { ...t, send, add, sources };
}

describe("予定イベントの暦の取得元", () => {
	test("追加・変更・削除と入力検証", async () => {
		const t = setup();
		const ok = await t.add({
			name: " 週次 ",
			url: ` ${URL_A} `,
			keywords: { cpi: " US CPI m/m ", nfp: "" },
		});
		expect(ok.status).toBe(201);
		const source = ok.body.source as EventSource;
		expect(source).toMatchObject({
			name: "週次",
			url: URL_A,
			keywords: { cpi: "US CPI m/m" },
			lastSuccessAt: null,
			stale: [],
		});
		expect(
			(await t.add({ name: "b", url: URL_A, keywords: { cpi: "x" } })).status,
		).toBe(409);
		expect(
			(await t.add({ name: "b", url: "ftp://b", keywords: { cpi: "x" } })).body
				.field,
		).toBe("url");
		expect(
			(await t.add({ name: "b", url: "https://b", keywords: { cpi: " " } }))
				.body.field,
		).toBe("keywords");
		expect(
			(await t.add({ name: "b", url: "https://b", keywords: { x: "y" } }))
				.status,
		).toBe(400);

		const put = await t.send("PUT", `/sources/${source.id}`, {
			name: "改名",
			url: URL_A,
			keywords: { cpi: "US CPI m/m" },
		});
		expect(put.status).toBe(200);
		expect((await t.sources())[0]?.name).toBe("改名");
		expect((await t.send("DELETE", `/sources/${source.id}`)).status).toBe(200);
		expect(await t.sources()).toEqual([]);
		expect((await t.send("DELETE", `/sources/${source.id}`)).status).toBe(404);
	});

	test("取得した暦で、その種類の暦が延び、判定に使う暦に入る", async () => {
		const t = setup();
		const cpi = END + 13 * D;
		t.icalFeeds.set(URL_A, [
			{ summary: "⁂ US CPI m/m", start: cpi, allDay: false },
			{ summary: "⁂ US CPI y/y", start: cpi, allDay: false },
			{ summary: "Bank Holiday", start: END + 15 * D, allDay: true },
		]);
		await t.add({ name: "週次", url: URL_A, keywords: { cpi: "US CPI" } });
		t.clock.now = END + 10 * D;
		await t.calendar.run();

		const cal = t.calendar.calendar();
		expect(cal.events.filter((e) => e.start > END)).toEqual([
			{ type: "cpi", start: cpi, end: cpi },
		]);
		// 載っている予定の範囲（取得した時刻から最後の予定まで）は米 CPI だけ暦がそろう
		expect(calendarGap(cal, ["cpi"], END + 10 * D, END + 15 * D)).toBeNull();
		expect(calendarGap(cal, ["cpi"], END - D, END + 11 * D)).not.toBeNull();
		expect(calendarGap(cal, ["nfp"], END + 10 * D, END + 11 * D)).toBe(
			"米雇用統計 の暦は 2027-01-01 0:00 まで",
		);
		const status = (await (await t.send("GET", "/status")).json()) as {
			coveredUntil: { type: string; until: number | null }[];
		};
		expect(status.coveredUntil.find((c) => c.type === "cpi")?.until).toBe(
			END + 15 * D + 1,
		);
		expect(status.coveredUntil.find((c) => c.type === "nfp")?.until).toBeNull();
		expect((await t.sources())[0]?.lastSuccessAt).toBe(END + 10 * D);
	});

	test("続けて取得すると前回の取得からの暦がつながり、予定の移動は置き換える", async () => {
		const t = setup();
		await t.add({
			name: "週次",
			url: URL_A,
			keywords: { fomc: "FOMC Statement" },
		});
		const w1 = END + 3 * D;
		t.icalFeeds.set(URL_A, [
			{ summary: "FOMC Statement", start: w1 + D, allDay: false },
		]);
		t.clock.now = w1;
		await t.calendar.run();
		// 予定が1日後ろへ動き、次の週の予定も載った
		t.icalFeeds.set(URL_A, [
			{ summary: "FOMC Statement", start: w1 + 2 * D, allDay: false },
			{ summary: "Other", start: w1 + 9 * D, allDay: false },
		]);
		t.clock.now = w1 + 6 * H;
		await t.calendar.run();
		const cal = t.calendar.calendar();
		expect(cal.events.filter((e) => e.start > END).map((e) => e.start)).toEqual(
			[w1 + 2 * D],
		);
		expect(cal.covered.fomc.at(-1)).toEqual({
			from: w1,
			until: w1 + 9 * D + 1,
		});
	});

	test("前回の取得の後に載っていた予定は、次の取得に載っていなくても残す", async () => {
		const t = setup();
		await t.add({ name: "週次", url: URL_A, keywords: { cpi: "CPI" } });
		const sat = END + 3 * D;
		// 土曜の取得: 今週の分（夜の予定まで）
		t.icalFeeds.set(URL_A, [
			{ summary: "CPI", start: sat - 2 * D, allDay: false },
			{ summary: "CPI", start: sat + 2 * H, allDay: false },
		]);
		t.clock.now = sat;
		await t.calendar.run();
		// 日曜の取得: 来週の分だけ
		t.icalFeeds.set(URL_A, [
			{ summary: "CPI", start: sat + 3 * D, allDay: false },
		]);
		t.clock.now = sat + 6 * H;
		await t.calendar.run();
		const cal = t.calendar.calendar();
		expect(cal.events.filter((e) => e.start > END).map((e) => e.start)).toEqual(
			[sat - 2 * D, sat + 2 * H, sat + 3 * D],
		);
		expect(cal.covered.cpi.at(-1)).toEqual({
			from: sat - 2 * D,
			until: sat + 3 * D + 1,
		});
	});

	test("取得の失敗は取得元に残し、語を変えると取得した暦を消して取り直す", async () => {
		const t = setup();
		const { body } = await t.add({
			name: "週次",
			url: URL_A,
			keywords: { cpi: "CPI" },
		});
		const id = (body.source as EventSource).id;
		t.clock.now = END + D;
		t.icalFeeds.set(URL_A, new Error("HTTP 403"));
		await t.calendar.run();
		expect((await t.sources())[0]).toMatchObject({
			lastError: "取得できない: HTTP 403",
			errorSince: END + D,
		});
		t.icalFeeds.set(URL_A, []);
		await t.calendar.run();
		expect((await t.sources())[0]?.lastError).toBe(
			"取得できない: 予定が1件も無い",
		);

		t.icalFeeds.set(URL_A, [
			{ summary: "US CPI", start: END + 2 * D, allDay: false },
		]);
		await t.calendar.run();
		expect(t.calendar.calendar().covered.cpi).toHaveLength(2);
		await t.send("PUT", `/sources/${id}`, {
			name: "週次",
			url: URL_A,
			keywords: { nfp: "NFP" },
		});
		const cal = t.calendar.calendar();
		expect(cal.covered.cpi).toEqual([EVENT_CALENDAR_RANGE]);
		expect(cal.events.some((e) => e.start > END)).toBe(false);
		expect((await t.sources())[0]).toMatchObject({
			lastSuccessAt: null,
			lastError: null,
		});
	});

	test("語を入れた種類が長く拾えなければ知らせる", async () => {
		const t = setup();
		await t.add({
			name: "週次",
			url: URL_A,
			keywords: { cpi: "CPI", boj: "BOJ" },
		});
		t.icalFeeds.set(URL_A, [
			{ summary: "US CPI", start: END + D, allDay: false },
		]);
		t.clock.now = END;
		await t.calendar.run();
		expect((await t.sources())[0]?.stale).toEqual([]);
		t.clock.now = END + 72 * D;
		expect((await t.sources())[0]?.stale).toEqual(["cpi", "boj"]);
		t.clock.now = END + 60 * D;
		expect((await t.sources())[0]?.stale).toEqual([]);
	});
});
