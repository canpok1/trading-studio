import { describe, expect, test } from "bun:test";
import { gzipSync, inflateRawSync } from "node:zlib";
import type {
	BacktestOrder,
	BacktestSummary,
	DecisionLog,
	Instrument,
	Trade,
} from "@trading-studio/core";
import {
	BTC_JPY,
	ETH_JPY,
	strategyTemplate,
	XRP_JPY,
} from "@trading-studio/core";
import { crc32 } from "../src/analysis-export/zip-infra";
import type { BacktestRun } from "../src/backtests/types-domain";
import { createTestApp } from "./test-app";

const M = 60_000;
const H = 3_600_000;
// JST 2026-09-26 00:00
const DAY = Date.UTC(2026, 8, 25, 15);

type T = ReturnType<typeof createTestApp>;

/** 中身の確認に使う ZIP の読み取り。createZip が書く形（deflate・データ記述子なし）だけ読む */
function unzip(buf: Uint8Array): Map<string, string> {
	const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const end = buf.length - 22;
	expect(v.getUint32(end, true)).toBe(0x06054b50);
	const count = v.getUint16(end + 10, true);
	let p = v.getUint32(end + 16, true);
	const out = new Map<string, string>();
	const decoder = new TextDecoder();
	for (let i = 0; i < count; i++) {
		expect(v.getUint32(p, true)).toBe(0x02014b50);
		const crc = v.getUint32(p + 16, true);
		const size = v.getUint32(p + 20, true);
		const nameLen = v.getUint16(p + 28, true);
		const local = v.getUint32(p + 42, true);
		const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
		const start = local + 30 + v.getUint16(local + 26, true);
		const data = inflateRawSync(buf.subarray(start, start + size));
		expect(crc32(data)).toBe(crc);
		out.set(name, decoder.decode(data));
		p += 46 + nameLen;
	}
	return out;
}

/** CSV を列名 → 値の行へ（テストの値は改行を含まない前提。引用符は外す） */
function rows(csv: string): Record<string, string>[] {
	const parse = (line: string) =>
		(line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? [])
			.slice(0, -1)
			.map((c) => c.replace(/,$/, ""))
			.map((c) =>
				c.startsWith('"') ? c.slice(1, -1).replaceAll('""', '"') : c,
			);
	const [head, ...body] = csv.trimEnd().split("\n");
	const cols = parse(head as string);
	return body.map((l) => {
		const cells = parse(l);
		return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
	});
}

function addNews(t: T, at: number, title: string) {
	const source = t.newsRepo.insertSource(
		{
			name: `S-${title}`,
			url: `https://a.example/${title}/feed`,
			language: "ja",
		},
		0,
	);
	t.newsRepo.saveFetched(
		source,
		[
			{
				title,
				url: `https://a.example/${title}`,
				summary: '概要, "引用"',
				publishedAt: at,
			},
		],
		at,
	);
	return (
		t.newsRepo.listNews(100).find((n) => n.title === title) as { id: number }
	).id;
}

function addBacktest(
	t: T,
	startedAt: number,
	instruments: [Instrument, ...Instrument[]] = [BTC_JPY],
	more: {
		orders?: BacktestOrder[];
		trades?: Trade[];
		decisions?: DecisionLog[];
		summary?: Partial<BacktestSummary>;
	} = {},
): number {
	const id = t.backtestRepo.create({
		name: "テスト",
		instrument: instruments[0],
		instruments,
		params: strategyTemplate("trend").params,
		timeframe: "1h",
		from: DAY,
		to: DAY + 24 * H,
		initialCash: 1_000_000,
		fees: { limitPpm: 0, marketPpm: 1000 },
		skipGaps: false,
		criteriaVersion: null,
		eventCriteriaVersion: null,
		newsDelayMs: null,
		newsDataVersion: null,
		segment: null,
		datasetRunId: null,
		startedAt,
		barCount: 24,
		stepTimeframe: "1h",
		stepLimited: false,
		aggregationRule: null,
	});
	const pack = (v: unknown) => gzipSync(JSON.stringify(v));
	const order: BacktestOrder = {
		id: "b1",
		side: "buy",
		type: "market",
		price: null,
		quantity: 1_000_000,
		placedAt: DAY,
		status: "filled",
		filledAt: DAY,
		fillPrice: 10_000_000,
		fee: 100,
		canceledAt: null,
		cancelReason: null,
		reason: "買い",
		pairId: null,
		pnl: null,
	};
	const trade: Trade = {
		buyOrderId: "b1",
		sellOrderId: "s1",
		entryTime: DAY,
		exitTime: DAY + H,
		quantity: 1_000_000,
		pnl: 500,
	};
	const decision: DecisionLog = {
		time: DAY,
		price: 10_000_000,
		cash: 1_000_000,
		position: { quantity: 0, entryPrice: null, openedAt: null },
		openOrderIds: [],
		intents: [
			{ kind: "place", side: "buy", type: "market", quantity: 1_000_000 },
		],
		nextEvalAt: DAY + H,
		note: "買う",
		state: null,
	};
	t.backtestRepo.finishDone(
		id,
		{
			summary: {
				pnl: 500,
				trades: 1,
				wins: 1,
				losses: 0,
				winRate: 100,
				profitFactor: null,
				averageHoldingMs: H,
				openPositionQuantity: 0,
				...more.summary,
			} as BacktestSummary,
			orderCount: 1,
			filledCount: 1,
			bars: pack({ times: [], closes: [] }),
			orders: pack([order, ...(more.orders ?? [])]),
			trades: pack([trade, ...(more.trades ?? [])]),
			decisions: pack([decision, ...(more.decisions ?? [])]),
		},
		startedAt + 1,
	);
	return id;
}

async function download(t: T, query: string) {
	const res = await t.app.request(`/api/export/analysis?${query}`);
	return res;
}

describe("分析用エクスポート", () => {
	test("期間の表と README を ZIP で返し、API キーは入れない", async () => {
		const t = createTestApp();
		t.clock.now = DAY + 3 * H + 30 * M;
		t.scoreRepo.setApiKey("SECRET-KEY-123", 0);
		const done = addNews(t, DAY + 10 * M, "done");
		t.scoreRepo.saveScore(
			done,
			{
				scores: { sentiment: 80, risk: 10 },
				duration: "short",
				comment: "上がりそう",
			},
			{
				scoredAt: DAY + 20 * M,
				criteriaVersion: 1,
				model: "m",
				appBuiltAt: null,
				attempts: 0,
			},
		);
		const failed = addNews(t, DAY + 30 * M, "failed");
		t.scoreRepo.saveFailure(failed, "壊れた応答", 3, null);
		addNews(t, DAY + 40 * M, "unscored");
		// 期間の後のニュースは入れない
		addNews(t, DAY + 25 * H, "later");
		const id = t.marketDataRepo.createImport("1m", "a.csv", 0);
		t.marketDataRepo.insertImported(
			"1m",
			[0, 1, 2].map((i) => ({
				time: DAY + i * M,
				open: 100,
				high: 110,
				low: 90,
				close: 100,
				volume: 10_000_000,
			})),
			id,
		);
		const run = addBacktest(t, DAY + H);
		// 期間の前の DVOL は入れない
		t.dvolRepo.save(
			[-H, 0, H].map((d) => ({
				time: DAY + d,
				open: 5523,
				high: 5600,
				low: 5500,
				close: 5550,
			})),
		);

		const res = await download(
			t,
			`from=${DAY}&to=${DAY + 24 * H}&backtests=${run}`,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/zip");
		expect(res.headers.get("content-disposition")).toBe(
			'attachment; filename="trading-studio-analysis-20260926-20260926.zip"',
		);
		const files = unzip(new Uint8Array(await res.arrayBuffer()));
		expect([...files.keys()]).toEqual([
			"README.md",
			"news.csv",
			"scoring_criteria.csv",
			"aggregation_rule.csv",
			"judgments.csv",
			"dvol_1h.csv",
			"candles_1m.csv",
			"strategies.csv",
			"paper_decisions.csv",
			"paper_orders.csv",
			"backtest_runs.csv",
			"backtest_instruments.csv",
			"backtest_orders.csv",
			"backtest_trades.csv",
			"backtest_decisions.csv",
		]);
		for (const text of files.values()) {
			expect(text).not.toContain("SECRET-KEY-123");
		}

		// README には全部の CSV の全部の列の説明がある
		const readme = files.get("README.md") as string;
		for (const [name, text] of files) {
			if (name === "README.md" || name === "candles_1m.csv") continue;
			expect(readme).toContain(`#### ${name}`);
			for (const c of (text.split("\n")[0] as string).split(",")) {
				expect(readme).toContain(`| ${c} |`);
			}
		}

		const news = rows(files.get("news.csv") as string);
		expect(news.map((n) => [n.title, n.score_status])).toEqual([
			["done", "done"],
			["failed", "failed"],
			["unscored", "unscored"],
		]);
		expect(news[0]).toMatchObject({
			summary: '概要, "引用"',
			sentiment: "80",
			risk: "10",
			published_at: String(DAY + 10 * M),
			published_at_jst: "2026-09-26T00:10:00.000+09:00",
			criteria_version: "1",
		});
		expect(news[0]).not.toHaveProperty("trend");
		expect(news[1]).toMatchObject({ error: "壊れた応答", attempts: "3" });

		// 1時間足の終わりごと。書き出した時刻より後は入れない
		const judgments = rows(files.get("judgments.csv") as string);
		expect(judgments.map((j) => j.time_jst)).toEqual([
			"2026-09-26T01:00:00.000+09:00",
			"2026-09-26T02:00:00.000+09:00",
			"2026-09-26T03:00:00.000+09:00",
		]);
		expect(judgments[0]).toMatchObject({
			sentiment: "+2",
			sentiment_average: "80",
			sentiment_count: "1",
			risk: "calm",
			risk_average: "10",
			risk_count: "1",
		});
		expect(judgments[0]).not.toHaveProperty("trend");

		expect(files.get("candles_1m.csv")).toBe(
			[
				"日時,始値,高値,安値,終値,出来高",
				"2026-09-26T00:00:00.000+09:00,100,110,90,100,0.1",
				"2026-09-26T00:01:00.000+09:00,100,110,90,100,0.1",
				"2026-09-26T00:02:00.000+09:00,100,110,90,100,0.1",
				"",
			].join("\n"),
		);

		const dvol = rows(files.get("dvol_1h.csv") as string);
		expect(dvol.map((d) => d.time_jst)).toEqual([
			"2026-09-26T00:00:00.000+09:00",
			"2026-09-26T01:00:00.000+09:00",
		]);
		expect(dvol[0]).toMatchObject({
			open: "55.23",
			high: "56",
			low: "55",
			close: "55.5",
		});

		const criteria = rows(files.get("scoring_criteria.csv") as string);
		expect(criteria[0]).toMatchObject({ version: "1", active: "true" });

		expect(rows(files.get("backtest_runs.csv") as string)[0]).toMatchObject({
			run_id: String(run),
			instruments: BTC_JPY.id,
			pnl: "500",
			win_rate: "100",
		});
		// 候補が1つの実行は全体の成績をその銘柄の成績として出す
		expect(rows(files.get("backtest_instruments.csv") as string)).toEqual([
			expect.objectContaining({
				run_id: String(run),
				instrument: BTC_JPY.id,
				pnl: "500",
				trades: "1",
				buy_hold_percent: "",
			}),
		]);
		expect(rows(files.get("backtest_orders.csv") as string)[0]).toMatchObject({
			run_id: String(run),
			instrument: BTC_JPY.id,
			order_id: "b1",
			fill_price: "10000000",
		});
		expect(rows(files.get("backtest_trades.csv") as string)[0]).toMatchObject({
			instrument: BTC_JPY.id,
			sell_order_id: "s1",
			pnl: "500",
		});
		expect(
			rows(files.get("backtest_decisions.csv") as string)[0],
		).toMatchObject({
			instrument: BTC_JPY.id,
			note: "買う",
			position_quantity: "0",
		});
		expect(readme).toContain(
			"| coincheck:xrp_jpy | XRP/JPY | 0.001 円 | 0.01 XRP |",
		);
	});

	test("候補が複数のバックテストは、注文・往復・判断と成績を銘柄ごとに区別できる", async () => {
		const t = createTestApp();
		const xrp = { instrument: XRP_JPY.id };
		const summary = (pnl: number) => ({
			pnl,
			trades: 1,
			wins: 1,
			losses: 0,
			winRate: 100,
			profitFactor: null,
			averageHoldingMs: H,
			buyHoldPercent: 1.5,
			openPositionQuantity: 0,
		});
		const run = addBacktest(t, DAY + H, [ETH_JPY, XRP_JPY], {
			orders: [
				{
					id: "b2",
					side: "buy",
					type: "market",
					price: null,
					quantity: 10_000,
					placedAt: DAY + H,
					status: "filled",
					filledAt: DAY + H,
					fillPrice: 250_123,
					fee: 3,
					canceledAt: null,
					cancelReason: null,
					reason: "買い",
					pairId: null,
					pnl: null,
					...xrp,
				},
			],
			trades: [
				{
					buyOrderId: "b2",
					sellOrderId: "s2",
					entryTime: DAY + H,
					exitTime: DAY + 2 * H,
					quantity: 10_000,
					pnl: 7,
					...xrp,
				},
			],
			decisions: [
				{
					time: DAY + H,
					price: 250_123,
					cash: 900_000,
					position: { quantity: 0, entryPrice: null, openedAt: null },
					openOrderIds: [],
					intents: [],
					nextEvalAt: DAY + 2 * H,
					note: "買う",
					state: null,
					...xrp,
				},
			],
			summary: {
				pnl: 507,
				byInstrument: {
					[ETH_JPY.id]: summary(500),
					[XRP_JPY.id]: summary(7),
				},
			},
		});
		const res = await download(
			t,
			`from=${DAY}&to=${DAY + 24 * H}&backtests=${run}`,
		);
		const files = unzip(new Uint8Array(await res.arrayBuffer()));
		expect(rows(files.get("backtest_runs.csv") as string)[0]).toMatchObject({
			instruments: `${ETH_JPY.id} ${XRP_JPY.id}`,
			pnl: "507",
		});
		expect(
			rows(files.get("backtest_instruments.csv") as string).map((r) => [
				r.instrument,
				r.pnl,
				r.buy_hold_percent,
			]),
		).toEqual([
			[ETH_JPY.id, "500", "1.5"],
			[XRP_JPY.id, "7", "1.5"],
		]);
		// 候補の先頭の銘柄のものは記録に銘柄が無いので、先頭の銘柄で埋める
		const ids = (file: string, id: string) =>
			rows(files.get(file) as string).map((r) => [r[id], r.instrument]);
		expect(ids("backtest_orders.csv", "order_id")).toEqual([
			["b1", ETH_JPY.id],
			["b2", XRP_JPY.id],
		]);
		expect(ids("backtest_trades.csv", "buy_order_id")).toEqual([
			["b1", ETH_JPY.id],
			["b2", XRP_JPY.id],
		]);
		expect(ids("backtest_decisions.csv", "time")).toEqual([
			[String(DAY), ETH_JPY.id],
			[String(DAY + H), XRP_JPY.id],
		]);
	});

	test("デモの判断と注文を、そのときの判定と銘柄付きで入れる", async () => {
		const t = createTestApp();
		const params = strategyTemplate("trend").params;
		// BTC/JPY 以外を候補に入れるには金額で注文する
		const created = t.strategies.create({
			name: "戦略A",
			from: {
				params: {
					...params,
					buys: params.buys.map((b) => ({ ...b, orderAmount: 100_000 })),
				},
				instruments: [ETH_JPY.id, XRP_JPY.id],
			},
		});
		if (!created.ok) throw new Error("setup");
		const sid = created.strategy.id;
		const decisionId = t.tradingRepo.addDecision(
			{ id: 1, mode: "paper" },
			{ id: sid, name: "戦略A" },
			{
				time: DAY + M,
				price: 10_000_000,
				cash: 1_000_000,
				position: { quantity: 0, entryPrice: null, openedAt: null },
				openOrderIds: [],
				intents: [],
				nextEvalAt: DAY + H,
				note: "様子見",
				state: null,
			},
			{ sentiment: "+1", risk: "normal" },
		);
		t.tradingRepo.addDecision(
			{ id: 1, mode: "paper" },
			{ id: sid, name: "戦略A" },
			{
				time: DAY + 2 * M,
				instrument: XRP_JPY.id,
				price: 250_123,
				cash: 1_000_000,
				position: { quantity: 0, entryPrice: null, openedAt: null },
				openOrderIds: [],
				intents: [],
				nextEvalAt: DAY + H,
				note: "XRP を見る",
				state: null,
			},
			{},
		);
		t.tradingRepo.saveOrders(
			{ id: 1, mode: "paper" },
			[
				{
					id: "o1",
					side: "buy",
					type: "market",
					price: null,
					quantity: 10_000,
					placedAt: DAY + 2 * M,
					status: "filled",
					filledAt: DAY + 2 * M,
					fillPrice: 250_123,
					fee: 3,
					canceledAt: null,
					cancelReason: null,
					reason: "買い",
					pairId: null,
					pnl: null,
				},
			],
			{
				instrument: XRP_JPY.id,
				decisionId: null,
				strategyId: sid,
				strategyName: "戦略A",
			},
		);
		const res = await download(t, `from=${DAY}&to=${DAY + 24 * H}`);
		const files = unzip(new Uint8Array(await res.arrayBuffer()));
		expect(rows(files.get("strategies.csv") as string)).toEqual([
			expect.objectContaining({
				strategy_id: String(sid),
				instruments: `${ETH_JPY.id} ${XRP_JPY.id}`,
			}),
		]);
		expect(rows(files.get("paper_decisions.csv") as string)).toEqual([
			// 銘柄を持たない判断は、戦略の候補に関わらず収集の先頭の銘柄のもの
			expect.objectContaining({
				instrument: BTC_JPY.id,
				decision_id: String(decisionId),
				run_id: "1",
				run_name: "デモ",
				strategy_name: "戦略A",
				note: "様子見",
				judgment_sentiment: "+1",
				judgment_risk: "normal",
			}),
			expect.objectContaining({ instrument: XRP_JPY.id, note: "XRP を見る" }),
		]);
		expect(rows(files.get("paper_orders.csv") as string)).toEqual([
			expect.objectContaining({
				order_id: "o1",
				instrument: XRP_JPY.id,
				fill_price: "250123",
			}),
		]);
		// 選ばなければバックテストの表は列名だけ
		expect(files.get("backtest_runs.csv")?.trimEnd().split("\n")).toHaveLength(
			1,
		);
	});

	test("期間内に完了したバックテストだけを選べる一覧に出す", async () => {
		const t = createTestApp();
		const inside = addBacktest(t, DAY + H);
		addBacktest(t, DAY + 25 * H);
		const res = await t.app.request(
			`/api/export/backtests?from=${DAY}&to=${DAY + 24 * H}`,
		);
		const { runs } = (await res.json()) as { runs: BacktestRun[] };
		expect(runs.map((r) => r.id)).toEqual([inside]);
	});

	test("期間やバックテストの指定が違えば断る", async () => {
		const t = createTestApp();
		expect((await download(t, `from=${DAY}&to=${DAY}`)).status).toBe(400);
		expect((await download(t, "from=a&to=1")).status).toBe(400);
		expect((await download(t, `from=0&to=${DAY}&backtests=1,x`)).status).toBe(
			400,
		);
		expect((await download(t, `from=0&to=${DAY}&backtests=99`)).status).toBe(
			404,
		);
		expect(
			(await t.app.request("/api/export/backtests?from=1&to=0")).status,
		).toBe(400);
	});
});
