import { describe, expect, test } from "bun:test";
import { calendarGap } from "@trading-studio/core";
import type { AskModel } from "../src/ai/job-domain";
import { BUNDLED_EVENTS, BUNDLED_RANGE } from "../src/calendar/bundled-domain";
import type {
	EventCriteria,
	EventSource,
	JudgmentCoverage,
} from "../src/calendar/types-domain";
import { createTestApp } from "./test-app";

const H = 3_600_000;
const D = 24 * H;
/** アプリが持つ予定の終わり（2027-01-01 0:00 JST） */
const END = BUNDLED_RANGE.until;
const URL_A = "https://a.example/week.ics";

const ev = (
	summary: string,
	start: number,
	uid?: string,
	description?: string,
) => ({
	uid: uid ?? null,
	summary,
	description: description ?? null,
	start,
	allDay: false,
});

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
	/** 判断を1件ずつ、仕事が無くなるまで進める */
	const judgeAll = async (ask: AskModel = demoAsk) => {
		for (let i = 0; i < 1000; i++) {
			const job =
				t.calendar.jobs.urgent(t.clock.now) ??
				t.calendar.jobs.background(t.clock.now);
			if (!job) return i;
			await job(ask);
		}
		throw new Error("判断が終わらない");
	};
	return { ...t, send, add, sources, judgeAll };
}

/** 件名に CPI があれば高、PPI なら中、ほかは低 */
const demoAsk: AskModel = async (prompt) => {
	const title = /件名: (.*)/.exec(prompt)?.[1] ?? "";
	return {
		value: {
			importance: /CPI|FOMC|雇用統計|日銀/.test(title)
				? "high"
				: /PPI/.test(title)
					? "medium"
					: "low",
			reason: "テストの判断",
		},
		model: "test-model",
	};
};

describe("予定の取得元", () => {
	test("追加・変更・削除と入力検証", async () => {
		const t = setup();
		const ok = await t.add({ name: " 週次 ", url: ` ${URL_A} ` });
		expect(ok.status).toBe(201);
		const source = ok.body.source as EventSource;
		expect(source).toMatchObject({
			name: "週次",
			url: URL_A,
			lastSuccessAt: null,
		});
		expect((await t.add({ name: "b", url: URL_A })).status).toBe(409);
		expect((await t.add({ name: "b", url: "ftp://b" })).body.field).toBe("url");
		expect((await t.add({ name: " ", url: "https://b" })).body.field).toBe(
			"name",
		);
		expect((await t.add({ name: "b" })).status).toBe(400);

		// 購読用の webcal:// は https:// で取る
		const webcal = await t.add({
			name: "購読",
			url: "webcal://c.example/cal.ics",
		});
		expect((webcal.body.source as EventSource).url).toBe(
			"https://c.example/cal.ics",
		);
		await t.send(
			"DELETE",
			`/sources/${(webcal.body.source as EventSource).id}`,
		);

		const put = await t.send("PUT", `/sources/${source.id}`, {
			name: "改名",
			url: URL_A,
		});
		expect(put.status).toBe(200);
		expect((await t.sources())[0]?.name).toBe("改名");
		expect((await t.send("DELETE", `/sources/${source.id}`)).status).toBe(200);
		expect(await t.sources()).toEqual([]);
		expect((await t.send("DELETE", `/sources/${source.id}`)).status).toBe(404);
	});

	test("取得した予定ですべての予定の暦が延び、判断した重要度で判定に使う暦に入る", async () => {
		const t = setup();
		const cpi = END + 13 * D;
		t.icalFeeds.set(URL_A, [
			ev("⁂ US CPI m/m", cpi, "1", "Impact: High"),
			ev("⁂ US PPI m/m", cpi + H, "2"),
		]);
		await t.add({ name: "週次", url: URL_A });
		t.clock.now = END + 10 * D;
		await t.calendar.run();

		// 判断するまでは重要度が未判断で、その予定に掛かる判定は暦切れ
		const before = t.calendar.calendar();
		expect(before.events.filter((e) => e.start > END)).toEqual([
			{ title: "⁂ US CPI m/m", start: cpi, end: cpi, importance: null },
			{ title: "⁂ US PPI m/m", start: cpi + H, end: cpi + H, importance: null },
		]);
		expect(calendarGap(before, cpi - H, cpi + H)).toBe(
			"「⁂ US CPI m/m」の重要度が未判断",
		);

		const status = async () =>
			(await (await t.send("GET", "/status")).json()) as {
				coveredUntil: number | null;
				unjudged: number;
			};
		expect((await status()).coveredUntil).toBe(cpi + H + 1);
		expect((await status()).unjudged).toBe(BUNDLED_EVENTS.length + 2);

		await t.judgeAll();
		const cal = t.calendar.calendar();
		expect(
			cal.events.filter((e) => e.start > END).map((e) => e.importance),
		).toEqual(["high", "medium"]);
		// 載っている予定の範囲（取得した時刻から最後の予定まで）は暦がそろう
		expect(calendarGap(cal, END + 10 * D, cpi + H)).toBeNull();
		expect(calendarGap(cal, END - D, END + 11 * D)).toBe(
			"暦は 2027-01-01 0:00 まで",
		);
		expect((await status()).unjudged).toBe(0);
		expect((await t.sources())[0]?.lastSuccessAt).toBe(END + 10 * D);
	});

	test("続けて取得すると前回の取得からの暦がつながり、予定の移動は同じ UID の予定を書き換え、消えた予定は消す", async () => {
		const t = setup();
		await t.add({ name: "週次", url: URL_A });
		const w1 = END + 3 * D;
		t.icalFeeds.set(URL_A, [
			ev("FOMC Statement", w1 + D, "f"),
			ev("取り消す予定", w1 + 2 * D, "x"),
		]);
		t.clock.now = w1;
		await t.calendar.run();
		await t.judgeAll();
		// 予定が1日後ろへ動き、次の週の予定も載った。件名が同じなら判断は残す
		t.icalFeeds.set(URL_A, [
			ev("FOMC Statement", w1 + 2 * D, "f"),
			ev("Other", w1 + 9 * D, "o"),
		]);
		t.clock.now = w1 + 6 * H;
		await t.calendar.run();
		const cal = t.calendar.calendar();
		expect(
			cal.events
				.filter((e) => e.start > END)
				.map((e) => [e.title, e.start, e.importance]),
		).toEqual([
			["FOMC Statement", w1 + 2 * D, "high"],
			["Other", w1 + 9 * D, null],
		]);
		expect(cal.covered.at(-1)).toEqual({ from: w1, until: w1 + 9 * D + 1 });
	});

	test("件名が変わった予定は判断し直し、説明だけの変更では判断を残す", async () => {
		const t = setup();
		await t.add({ name: "週次", url: URL_A });
		const at = END + 3 * D;
		t.icalFeeds.set(URL_A, [ev("US CPI", at, "1")]);
		t.clock.now = END;
		await t.calendar.run();
		await t.judgeAll();
		t.icalFeeds.set(URL_A, [ev("US PPI", at, "1")]);
		await t.calendar.run();
		expect(
			t.calendar.calendar().events.find((e) => e.start === at)?.importance,
		).toBeNull();
		expect(await t.judgeAll()).toBe(1);
		expect(
			t.calendar.calendar().events.find((e) => e.start === at)?.importance,
		).toBe("medium");
		t.icalFeeds.set(URL_A, [ev("US PPI", at, "1", "Actual: 0.3%")]);
		await t.calendar.run();
		expect(
			t.calendar.calendar().events.find((e) => e.start === at)?.importance,
		).toBe("medium");
	});

	test("判断の間に件名が変わるか予定が消えたら、その判断は残さない", async () => {
		const t = setup();
		await t.add({ name: "週次", url: URL_A });
		const at = END + 3 * D;
		t.icalFeeds.set(URL_A, [ev("US CPI", at, "1")]);
		t.clock.now = END;
		await t.calendar.run();
		const slow = async (change: () => Promise<void>): ReturnType<AskModel> => {
			await change();
			return { value: { importance: "high", reason: "r" }, model: "m" };
		};
		const job = t.calendar.jobs.urgent(t.clock.now);
		await job?.(() =>
			slow(async () => {
				t.icalFeeds.set(URL_A, [ev("US PPI", at, "1")]);
				await t.calendar.run();
			}),
		);
		expect(
			t.calendar.calendar().events.find((e) => e.start === at)?.importance,
		).toBeNull();
		// 予定が消えても例外にしない
		const again = t.calendar.jobs.urgent(t.clock.now);
		await again?.(() =>
			slow(async () => {
				t.icalFeeds.set(URL_A, [ev("US GDP", at + D, "2")]);
				await t.calendar.run();
			}),
		);
		expect(t.calendar.calendar().events.some((e) => e.start === at)).toBe(
			false,
		);
	});

	test("前回の取得の後に載っていた予定は、次の取得に載っていなくても残す", async () => {
		const t = setup();
		await t.add({ name: "週次", url: URL_A });
		const sat = END + 3 * D;
		// 土曜の取得: 今週の分（夜の予定まで）
		t.icalFeeds.set(URL_A, [
			ev("CPI", sat - 2 * D, "1"),
			ev("CPI", sat + 2 * H, "2"),
		]);
		t.clock.now = sat;
		await t.calendar.run();
		// 日曜の取得: 来週の分だけ
		t.icalFeeds.set(URL_A, [ev("CPI", sat + 3 * D, "3")]);
		t.clock.now = sat + 6 * H;
		await t.calendar.run();
		const cal = t.calendar.calendar();
		expect(cal.events.filter((e) => e.start > END).map((e) => e.start)).toEqual(
			[sat - 2 * D, sat + 2 * H, sat + 3 * D],
		);
		expect(cal.covered.at(-1)).toEqual({
			from: sat - 2 * D,
			until: sat + 3 * D + 1,
		});
	});

	test("取得の失敗は取得元に残し、URL を変えると取得した予定を消して取り直す", async () => {
		const t = setup();
		const { body } = await t.add({ name: "週次", url: URL_A });
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

		t.icalFeeds.set(URL_A, [ev("US CPI", END + 2 * D, "1")]);
		await t.calendar.run();
		expect(t.calendar.calendar().covered).toHaveLength(2);
		await t.send("PUT", `/sources/${id}`, {
			name: "週次",
			url: "https://b.example/week.ics",
		});
		const cal = t.calendar.calendar();
		expect(cal.covered).toEqual([BUNDLED_RANGE]);
		expect(cal.events.some((e) => e.start > END)).toBe(false);
		expect((await t.sources())[0]).toMatchObject({
			lastSuccessAt: null,
			lastError: null,
		});
	});
});

describe("予定の一覧", () => {
	test("期間に掛かる予定を判断とともに始まりの順に返し、重要度の下限で判断済みの低いものを除く", async () => {
		const t = setup();
		await t.add({ name: "週次", url: URL_A });
		const at = END + 3 * D;
		t.icalFeeds.set(URL_A, [
			ev("US PPI", at, "2", "Impact: Medium"),
			ev("US CPI", at - D, "1"),
			ev("Bank Holiday", at + D, "3"),
			ev("Later", at + 2 * D, "4"),
		]);
		t.clock.now = END;
		await t.calendar.run();
		const list = async (q: string) => {
			const res = await t.send(
				"GET",
				`/events?from=${at - D}&to=${at + D}${q}`,
			);
			return {
				status: res.status,
				body: (await res.json()) as {
					version: number;
					total: number;
					events: {
						title: string;
						sourceName: string | null;
						judgment: unknown;
					}[];
				},
			};
		};
		let r = await list("");
		expect(r.body.version).toBe(1);
		expect(r.body.events.map((e) => e.title)).toEqual([
			"US CPI",
			"US PPI",
			"Bank Holiday",
		]);
		expect(r.body.events[0]).toMatchObject({
			sourceName: "週次",
			judgment: null,
		});
		// 判断していない予定は重要度で絞っても残す
		expect((await list("&minImportance=high")).body.total).toBe(3);
		await t.judgeAll();
		r = await list("&minImportance=medium");
		expect(r.body.events.map((e) => e.title)).toEqual(["US CPI", "US PPI"]);
		expect(r.body.events[1]?.judgment).toMatchObject({
			status: "done",
			importance: "medium",
			reason: "テストの判断",
			model: "test-model",
		});
		expect((await list("&minImportance=huge")).status).toBe(400);
		expect((await list("&version=9")).status).toBe(404);
	});

	test("判断に失敗して止めた予定1件を判断し直せる。判断済みの予定は頼めない", async () => {
		const t = setup();
		await t.add({ name: "週次", url: URL_A });
		const at = END + 3 * D;
		t.icalFeeds.set(URL_A, [ev("US CPI", at, "1"), ev("US PPI", at + D, "2")]);
		t.clock.now = END;
		await t.calendar.run();
		const broken: AskModel = async () => ({ value: {}, model: "m" });
		// CPI を再試行の回数を超えて失敗させる
		for (const wait of [0, 30_000, 120_000, 600_000]) {
			t.clock.now += wait;
			await t.calendar.jobs.urgent(t.clock.now)?.(broken);
		}
		await t.judgeAll();
		const events = (
			(await (
				await t.send("GET", `/events?from=${at}&to=${at + D}`)
			).json()) as {
				events: { id: number; title: string; judgment: { status: string } }[];
			}
		).events;
		const cpi = events.find((e) => e.title === "US CPI");
		const ppi = events.find((e) => e.title === "US PPI");
		expect(cpi?.judgment.status).toBe("failed");
		expect(ppi?.judgment.status).toBe("done");
		expect((await t.send("POST", `/events/${ppi?.id}/judge`, {})).status).toBe(
			404,
		);
		expect((await t.send("POST", `/events/${cpi?.id}/judge`, {})).status).toBe(
			200,
		);
		await t.calendar.jobs.background(t.clock.now)?.(demoAsk);
		expect(
			t.calendar.calendar().events.find((e) => e.start === at)?.importance,
		).toBe("high");
		expect((await t.send("POST", "/events/99999/judge", {})).status).toBe(404);
		expect(
			(await t.send("POST", `/events/${cpi?.id}/judge`, { version: 9 })).status,
		).toBe(404);
	});
});

describe("予定の重要度の判断", () => {
	test("アプリが持つ過去の予定も判断し、使用中の版の運用で見る予定を先に、過去の予定は新しい順に判断する", async () => {
		const t = setup();
		const last = BUNDLED_EVENTS.at(-1)?.start as number;
		t.clock.now = last - D;
		const seen: string[] = [];
		const ask: AskModel = async (prompt, schema) => {
			seen.push(/日時: (.*)/.exec(prompt)?.[1] ?? "");
			return demoAsk(prompt, schema);
		};
		const job = t.calendar.jobs.urgent(t.clock.now);
		await job?.(ask);
		// 運用で見る範囲は7日前に終わった予定から
		expect(t.calendar.jobs.urgent(t.clock.now)).not.toBeNull();
		while (t.calendar.jobs.urgent(t.clock.now))
			await t.calendar.jobs.urgent(t.clock.now)?.(ask);
		const past = t.calendar.jobs.background(t.clock.now);
		await past?.(ask);
		const urgentCount = seen.length - 1;
		expect(seen.slice(0, urgentCount)).toEqual(
			[...seen.slice(0, urgentCount)].sort(),
		);
		// 過去の予定は運用で見る範囲より前の、一番新しいもの
		expect((seen[urgentCount] as string) < (seen[0] as string)).toBe(true);
		expect(
			t.calendar
				.calendar()
				.events.filter((e) => e.importance !== null)
				.every((e) => e.title.length > 0),
		).toBe(true);
	});

	test("AI の失敗は間を延ばして再試行し、回数を超えたら止める。形の違う応答も失敗", async () => {
		const t = setup();
		t.clock.now = END;
		const at = END + D;
		await t.add({ name: "週次", url: URL_A });
		t.icalFeeds.set(URL_A, [ev("US CPI", at, "1")]);
		await t.calendar.run();
		const broken: AskModel = async () => ({
			value: { importance: "huge" },
			model: "m",
		});
		const next = () => t.calendar.jobs.urgent(t.clock.now);
		await next()?.(broken);
		// 再試行の時刻まで待つ
		expect(next()).toBeNull();
		t.clock.now += 30_000;
		await next()?.(async () => {
			throw new Error("HTTP 429");
		});
		t.clock.now += 120_000;
		await next()?.(broken);
		t.clock.now += 600_000;
		await next()?.(broken);
		t.clock.now += 3_600_000 - 1;
		expect(next()).toBeNull();
		const cov = t.calendar.judgmentCoverage(at, at, 1) as JudgmentCoverage;
		expect(cov).toEqual({ total: 1, done: 0, pending: 0, failed: 1 });
		expect(t.calendar.status().failed).toBe(1);
		// 失敗して止めた予定は重要度が無いまま暦に残り、前後は暦切れになる
		expect(
			t.calendar.calendar().events.find((e) => e.title === "US CPI")
				?.importance,
		).toBeNull();
		// 使用中の版では1時間後に判断し直す
		t.clock.now += 1;
		expect(next()).not.toBeNull();
		// 失敗して止めた予定は、頼み直すと過去の予定より先に判断する
		t.calendar.requestJudgments(at, at, 1);
		await t.calendar.jobs.background(t.clock.now)?.(demoAsk);
		expect(t.calendar.judgmentCoverage(at, at, 1)).toEqual({
			total: 1,
			done: 1,
			pending: 0,
			failed: 0,
		});
	});

	test("評価基準の版を足して使用中を切り替えると、その版で判断し直す。使用中でない版は頼んだ期間だけ判断する", async () => {
		const t = setup();
		t.clock.now = END;
		await t.judgeAll();
		const criteria = async () =>
			(await (await t.send("GET", "/criteria")).json()) as EventCriteria;
		const first = await criteria();
		expect(first.activeVersion).toBe(1);
		expect(first.template).toContain("{event}");
		expect(
			(
				await t.send("POST", "/criteria", {
					text: first.versions[0]?.text,
					note: "",
				})
			).status,
		).toBe(400);
		const added = await t.send("POST", "/criteria", {
			text: "すべて high にする",
			note: "試す",
		});
		expect(added.status).toBe(201);
		// 使用中でない版は頼んだ期間だけ
		const from = BUNDLED_EVENTS[0]?.start as number;
		const to = from + 30 * D;
		const get = async () =>
			(
				(await (
					await t.send("GET", `/judgments?from=${from}&to=${to}&version=2`)
				).json()) as { coverage: JudgmentCoverage }
			).coverage;
		const before = await get();
		expect(before.done).toBe(0);
		expect(before.total).toBeGreaterThan(0);
		const req = await t.send("POST", "/judgments", { from, to, version: 2 });
		expect(
			((await req.json()) as { coverage: JudgmentCoverage }).coverage.pending,
		).toBe(before.total);
		expect(await t.judgeAll()).toBe(before.total);
		expect((await get()).done).toBe(before.total);
		expect(
			(await t.send("GET", `/judgments?from=${from}&to=${to}&version=9`))
				.status,
		).toBe(404);

		// 使用中を切り替えると、その版で判断していない予定をすべて判断する
		expect(
			(await t.send("PUT", "/criteria/active", { version: 2 })).status,
		).toBe(200);
		expect(await t.judgeAll()).toBe(BUNDLED_EVENTS.length - before.total);
		expect(
			(await t.send("PUT", "/criteria/active", { version: 9 })).status,
		).toBe(404);
	});

	test("採点の合間に、ニュースの採点と間隔を共有して判断を進める", async () => {
		const t = setup();
		t.clock.now = END;
		t.eventJobs.on = true;
		t.scorer.tick();
		await t.scorer.idle();
		expect(
			t.calendar.calendar().events.filter((e) => e.importance !== null),
		).toHaveLength(1);
	});
});
