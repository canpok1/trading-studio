// 自動取引の常駐実行。受信した約定で仮想注文の約定を決め、次の判定時刻に戦略を評価する。
// 状態（口座・未約定の注文・戦略の state・次の判定時刻）はすべて DB に置き、再起動しても続きから動く

import type {
	Candle,
	FeeRates,
	MarketTrade,
	Timeframe,
	TradeOrder,
} from "@trading-studio/core";
import {
	aggregateCandles,
	cancelAll,
	candleStart,
	conditionStrategy,
	DEFAULT_FEE_RATES,
	dailyLossBlock,
	decide,
	expireOrders,
	idealStepTimeframe,
	JUDGES,
	newAccount,
	publicLots,
	RUN_LIMITS,
	realizedPnlOn,
	settleFills,
	TIMEFRAME_MS,
	TRADING_LIMITS,
	tradeFillPrice,
	validateConditionSet,
	watchConditionSet,
} from "@trading-studio/core";
import type { CalendarService } from "../calendar/types-domain";
import type { LiveMarket } from "../collector/collector-domain";
import { strategyDvol } from "../dvol/dvol-domain";
import type { DvolRepository } from "../dvol/repository-domain";
import type { JudgmentService } from "../judgments/types-domain";
import type { MarketDataRepository } from "../market-data/repository-domain";
import type {
	StoredStrategy,
	StrategyService,
} from "../strategies/types-domain";
import { equityOf, tradingPerformance } from "./performance-domain";
import type { TradingRepository, TradingRunRow } from "./repository-domain";
import type {
	AutoTradingStatus,
	OrderFilter,
	StrategyLock,
	TradingFailure,
	TradingResult,
	TradingService,
} from "./types-domain";

/** 削除の途中で戦略が消えていたことを、トランザクションを巻き戻して知らせる */
class StrategyGone extends Error {}

/** デモの注文の id の頭につける文字 */
const PAPER_ID_PREFIX = "p";

export type TradingEngine = TradingService & {
	/** 受信した約定（収集が動いている間に届いたものだけ）。仮想注文の約定を決める */
	onTrades(trades: readonly MarketTrade[]): void;
	/** 定期的に呼ぶ（main では1秒ごと）。期限切れの指値の取消と、判定時刻が来た戦略の評価を行う */
	tick(): void;
};

export function createTradingService({
	repo,
	strategies,
	judgments,
	calendar,
	dvol,
	marketData,
	market,
	now = Date.now,
	fees = DEFAULT_FEE_RATES,
}: {
	repo: TradingRepository;
	strategies: Pick<StrategyService, "get" | "list" | "create" | "remove">;
	judgments: Pick<JudgmentService, "current">;
	calendar: Pick<CalendarService, "calendar">;
	dvol: Pick<DvolRepository, "bars" | "fetchState">;
	marketData: Pick<
		MarketDataRepository,
		"instrument" | "candlesBefore" | "loadCandles" | "lastCandle"
	>;
	market: () => LiveMarket;
	now?: () => number;
	fees?: FeeRates;
}): TradingEngine {
	/**
	 * オンにしたときの最初の判定時刻。バックテストで判定に使う足の次の足の終わり（バックテストで足の終わりに判定するのと揃える）。
	 * 秒単位の判定頻度でどの足でも割り切れなければ1分足
	 */
	const firstEvalAt = (s: StoredStrategy, t: number) => {
		const tf = idealStepTimeframe(s.params) ?? "1m";
		return candleStart(t, tf) + TIMEFRAME_MS[tf];
	};

	/** 注文の記録の変化を保存する */
	const saveChanges = (
		run: TradingRunRow,
		changed: readonly TradeOrder[],
		origin: { decisionId: number | null; strategy: StoredStrategy | null },
	) => {
		repo.saveOrders(run, changed, {
			decisionId: origin.decisionId,
			strategyId: origin.strategy?.id ?? null,
			strategyName: origin.strategy?.name ?? "",
		});
	};

	/**
	 * 戦略が頼む粒度ごとの足と、直近の細かい足（1分足）。確定した足に、途中の足（保存済みの1分足と形成中の1分足から作る）を足す
	 */
	const candlesAt = (s: StoredStrategy, t: number, live: LiveMarket) => {
		const needs = conditionStrategy.candleNeeds(s.params);
		const timeframes = Object.keys(needs) as Timeframe[];
		const recentMs = conditionStrategy.recentMs(s.params);
		// 足の終わりちょうどに評価したときは、終わったばかりの足を今の足とする（バックテストで足の終わりに判定するのと揃える）
		const starts = timeframes.map((tf) => candleStart(t - 1, tf));
		const earliest = Math.min(candleStart(t - 1 - recentMs, "1m"), ...starts);
		// 保存済みの1分足に、収集がまだ保存していない1分足（確定待ち・形成中）を重ねる
		const byTime = new Map<number, Candle>();
		for (const c of [
			...marketData.loadCandles("1m", earliest, t),
			...live.unsaved,
			...(live.forming ? [live.forming] : []),
		]) {
			if (c.time >= earliest && c.time < t) byTime.set(c.time, c);
		}
		const minutes = [...byTime.values()].sort((a, b) => a.time - b.time);
		const candles: Partial<Record<Timeframe, Candle[]>> = {};
		timeframes.forEach((tf, i) => {
			const start = starts[i] as number;
			const done = marketData.candlesBefore(
				tf,
				start,
				Math.max(1, needs[tf] ?? 1) - 1,
			);
			const current = aggregateCandles(
				minutes.filter((c) => c.time >= start),
				tf,
			)[0];
			candles[tf] = current ? [...done, current] : done;
		});
		return {
			candles,
			recent: {
				timeframeMs: TIMEFRAME_MS["1m"],
				candles:
					recentMs > 0
						? minutes.filter((c) => c.time >= t - recentMs - TIMEFRAME_MS["1m"])
						: [],
			},
		};
	};

	/** 今の評価ルールでの判定器ごとの判定。採点の記録が始まる前は空（データなし） */
	const judgmentValues = (): Record<string, string> => {
		const current = judgments.current();
		const values: Record<string, string> = {};
		if (
			current.firstScoredAt !== null &&
			current.time >= current.firstScoredAt
		) {
			for (const j of JUDGES) values[j] = current.results[j].value;
		}
		return values;
	};

	const judgmentInput = (values: Record<string, string>, t: number) =>
		Object.fromEntries(
			Object.entries(values).map(([judge, label]) => [
				judge,
				[{ judge, time: t, label }],
			]),
		);

	const evaluate = (row: TradingRunRow, t: number) => {
		if (!row.enabled || row.nextEvalAt === null) return;
		if (t < row.nextEvalAt && !row.reevaluate) return;
		const live = market();
		// 収集が止まっている間は判定しない（古い価格で注文しないため）。復帰したら過ぎた判定を1回だけ行う
		if (live.status.state !== "running" || !live.latestTrade) return;
		const s = row.strategyId === null ? null : strategies.get(row.strategyId);
		if (!s) {
			// 動かしている戦略が消えたら続けられないので止める。未約定の注文は残す
			console.error("trading: running strategy not found", row.strategyId);
			repo.saveRun({
				...row,
				enabled: false,
				nextEvalAt: null,
				reevaluate: false,
			});
			return;
		}
		// 戦略が使わない判定も、注文の詳細で「そのときの判定」として見せるため記録する
		const values = judgmentValues();
		const expired = expireOrders(row.account, t);
		saveChanges(row, expired.changed, { decisionId: null, strategy: null });
		const out = decide({
			instrument: marketData.instrument,
			strategy: conditionStrategy,
			params: s.params,
			now: t,
			price: (live.latestTrade as MarketTrade).price,
			...candlesAt(s, t, live),
			judgments: judgmentInput(values, t),
			events: calendar.calendar(),
			dvol: strategyDvol(dvol, s.params, t, t),
			account: expired.account,
			state: row.state,
			fees,
			idPrefix: PAPER_ID_PREFIX,
		});
		const decisionId = repo.addDecision(
			row,
			{ id: s.id, name: s.name },
			out.decision,
			values,
		);
		saveChanges(row, out.changed, { decisionId, strategy: s });
		repo.saveRun({
			...row,
			account: out.account,
			state: out.state,
			nextEvalAt: out.nextEvalAt,
			reevaluate: false,
		});
	};

	/** 資産の評価に使う今の価格。収集が止まっていれば保存済みの最後の1分足の終値 */
	const currentPrice = (live: LiveMarket): number | null =>
		live.latestTrade?.price ?? marketData.lastCandle("1m")?.close ?? null;

	/** 戦略の条件の変更を止めている理由。保有はオフにしても口座に残り、オンにし直すと同じ戦略で売るため、保有がある間も止める */
	const lockOf = (row: TradingRunRow): StrategyLock | null =>
		row.enabled
			? "running"
			: row.account.lots.length > 0 || row.account.openOrders.length > 0
				? "holding"
				: null;

	const statusOf = (
		s: StoredStrategy,
		row: TradingRunRow,
		t: number,
		live: LiveMarket,
	): AutoTradingStatus => {
		const a = row.account;
		return {
			id: s.id,
			accountId: row.id,
			instrument: marketData.instrument,
			name: s.name,
			enabled: row.enabled,
			mode: row.mode,
			nextEvalAt: row.enabled ? row.nextEvalAt : firstEvalAt(s, t),
			startedAt: row.enabled ? row.startedAt : null,
			ranSinceReset:
				row.enabled || (row.startedAt !== null && row.startedAt >= row.resetAt),
			waitingForMarket:
				row.enabled &&
				(live.status.state !== "running" || live.latestTrade === null),
			dailyLoss: {
				loss: Math.max(0, -realizedPnlOn(a, t)),
				limit: s.params.dailyLossLimit,
				blocked: dailyLossBlock(a, t, s.params.dailyLossLimit) !== null,
			},
			strategyLock: lockOf(row),
			account: {
				initialCash: row.initialCash,
				cash: a.cash,
				position: a.position,
				lots: publicLots(a.lots),
				openOrderCount: a.openOrders.length,
				resetAt: row.resetAt,
				equity: equityOf(
					marketData.instrument,
					a.cash,
					a.position,
					currentPrice(live),
				),
			},
		};
	};

	const fail = (
		kind: Exclude<TradingFailure, { errors: unknown }>["kind"],
		message: string,
	): { ok: false; error: TradingFailure } => ({
		ok: false,
		error: { kind, message },
	});

	const notFound = () => fail("not_found", "戦略が見つからない");

	/** 戦略と、その口座 */
	const accountOf = (
		strategyId: number,
	): { s: StoredStrategy; row: TradingRunRow } | null => {
		const s = strategies.get(strategyId);
		const row = s ? repo.runOf(strategyId) : null;
		return s && row ? { s, row } : null;
	};

	const okRun = (strategyId: number): TradingResult => {
		const found = accountOf(strategyId);
		return found
			? { ok: true, status: statusOf(found.s, found.row, now(), market()) }
			: notFound();
	};

	/** 口座の id。読めなければ空にし、見回りを例外で止めない */
	const runIds = (): number[] => {
		try {
			return repo.runIds();
		} catch (e) {
			console.error("trading: runs unreadable", e);
			return [];
		}
	};

	/** 戦略の絞り込みを口座の絞り込みにする。戦略の口座が無ければ null（該当なし） */
	const runFilter = ({ strategyId, ...rest }: OrderFilter) => {
		if (strategyId === undefined) return rest;
		const row = repo.runOf(strategyId);
		return row ? { ...rest, runId: row.id } : null;
	};

	return {
		onTrades(trades) {
			if (trades.length === 0) return;
			const sorted = [...trades].sort((a, b) => a.time - b.time || a.id - b.id);
			// 1つの運用の失敗で、ほかの運用の約定を巻き戻さない
			for (const id of runIds()) {
				try {
					repo.transaction(() => {
						const row = repo.run(id);
						if (row?.mode !== "paper") return;
						let { account } = row;
						if (account.openOrders.length === 0) return;
						let filled = false;
						for (const trade of sorted) {
							if (account.openOrders.length === 0) break;
							// 期限を過ぎてから届いた約定では約定させない
							const expired = expireOrders(account, trade.time);
							saveChanges(row, expired.changed, {
								decisionId: null,
								strategy: null,
							});
							const out = settleFills(
								expired.account,
								(o) => tradeFillPrice(o, trade),
								trade.time,
								fees,
								marketData.instrument,
							);
							saveChanges(row, out.changed, {
								decisionId: null,
								strategy: null,
							});
							account = out.account;
							filled ||= out.filled;
						}
						// 自分の注文が約定したら、次の見回りで評価し直す（バックテストで約定した足の終わりに判定するのと揃える）
						repo.saveRun({
							...row,
							account,
							reevaluate: row.reevaluate || (filled && row.enabled),
						});
					});
				} catch (e) {
					console.error("trading: settle failed", id, e);
				}
			}
		},

		tick() {
			const t = now();
			for (const id of runIds()) {
				// 1つの運用の失敗で、ほかの運用を止めない
				try {
					repo.transaction(() => {
						const row = repo.run(id);
						if (!row) return;
						const expired = expireOrders(row.account, t);
						if (expired.changed.length === 0) {
							evaluate(row, t);
							return;
						}
						saveChanges(row, expired.changed, {
							decisionId: null,
							strategy: null,
						});
						const next = { ...row, account: expired.account };
						repo.saveRun(next);
						evaluate(next, t);
					});
				} catch (e) {
					console.error("trading: tick failed", id, e);
				}
			}
		},

		runs() {
			const t = now();
			const live = market();
			const rows = new Map(repo.runs().map((r) => [r.strategyId, r]));
			return strategies.list().flatMap((s) => {
				const row = rows.get(s.id);
				return row ? [statusOf(s, row, t, live)] : [];
			});
		},

		run(strategyId) {
			const found = accountOf(strategyId);
			return found ? statusOf(found.s, found.row, now(), market()) : null;
		},

		watch(strategyId) {
			const found = accountOf(strategyId);
			if (!found) return null;
			const { s, row } = found;
			const live = market();
			const price = currentPrice(live);
			if (price === null) return { watch: null };
			const t = now();
			// 期限切れの指値は次の判定の前に取り消されるので、取り消した後の口座で試算する
			const a = expireOrders(row.account, t).account;
			return {
				watch: watchConditionSet({
					instrument: marketData.instrument,
					now: t,
					price,
					...candlesAt(s, t, live),
					judgments: judgmentInput(judgmentValues(), t),
					events: calendar.calendar(),
					dvol: strategyDvol(dvol, s.params, t, t),
					lots: publicLots(a.lots),
					cash: a.cash,
					openOrders: a.openOrders.map((x) => ({ ...x.order })),
					params: s.params,
					state: row.state,
					buyBlocked: dailyLossBlock(a, t, s.params.dailyLossLimit),
				}),
			};
		},

		summaries() {
			return this.runs()
				.filter(
					(r) =>
						r.mode === "paper" && (r.enabled || r.strategyLock === "holding"),
				)
				.map((status) => {
					const w = this.watch(status.id)?.watch ?? null;
					const multiBuy =
						(strategies.get(status.id)?.params.buys.length ?? 0) >= 2;
					return {
						status,
						performance: this.performance(status.id),
						nextMoves: w && { price: w.price, moves: w.moves, multiBuy },
					};
				});
		},

		createStrategy(input) {
			return repo.transaction(() => {
				const r = strategies.create(input);
				if (r.ok) repo.createRun(r.strategy, now());
				return r;
			});
		},

		remove(strategyId) {
			const found = accountOf(strategyId);
			if (!found) return notFound();
			const { row } = found;
			if (row.enabled) {
				return fail("running", "戦略を消すには先に自動取引を停止する");
			}
			const t = now();
			try {
				repo.transaction(() => {
					const canceled = cancelAll(row.account, t, "戦略の削除で取消");
					saveChanges(row, canceled.changed, {
						decisionId: null,
						strategy: null,
					});
					repo.saveRun({ ...row, account: canceled.account });
					repo.deleteRun(row.id, t);
					// 間に消されていたら、口座の削除も巻き戻す
					if (!strategies.remove(strategyId)) throw new StrategyGone();
				});
			} catch (e) {
				if (e instanceof StrategyGone) return notFound();
				throw e;
			}
			return { ok: true };
		},

		start(strategyId) {
			const found = accountOf(strategyId);
			if (!found) return notFound();
			const { s, row } = found;
			if (row.mode !== "paper") {
				return fail(
					"unsupported_mode",
					"リアルはまだ選べない（フェーズ5で有効にする）",
				);
			}
			if (row.enabled) return fail("running", "自動取引は既に稼働中");
			if (repo.runningCount() >= TRADING_LIMITS.running) {
				return fail(
					"limit",
					`同時に動かせる戦略は ${TRADING_LIMITS.running} つまで。ほかの戦略を停止してから開始する`,
				);
			}
			const errors = validateConditionSet(s.params, RUN_LIMITS);
			if (errors.length > 0) {
				return {
					ok: false,
					error: {
						kind: "invalid_strategy",
						message: "戦略の条件に足りないものがある",
						errors,
					},
				};
			}
			const t = now();
			// 戦略の state はオンにするたびに初めから。保有と未約定の注文は口座に残っている
			repo.saveRun({
				...row,
				enabled: true,
				state: null,
				nextEvalAt: firstEvalAt(s, t),
				reevaluate: false,
				startedAt: t,
			});
			return okRun(strategyId);
		},

		stop(strategyId) {
			const found = accountOf(strategyId);
			if (!found) return notFound();
			const { row } = found;
			if (!row.enabled) return fail("not_running", "自動取引は既に停止中");
			repo.saveRun({
				...row,
				enabled: false,
				nextEvalAt: null,
				reevaluate: false,
			});
			return okRun(strategyId);
		},

		reset(strategyId, initialCash) {
			if (!Number.isSafeInteger(initialCash) || initialCash < 1) {
				return fail("invalid_cash", "開始時の資金は 1 円以上の整数で入れる");
			}
			const found = accountOf(strategyId);
			if (!found) return notFound();
			const { row } = found;
			if (row.enabled) {
				return fail("running", "リセットは自動取引を停止してから行う");
			}
			const t = now();
			repo.transaction(() => {
				const canceled = cancelAll(row.account, t, "口座のリセットで取消");
				saveChanges(row, canceled.changed, {
					decisionId: null,
					strategy: null,
				});
				// 注文の id が過去の記録と重ならないよう、通し番号は引き継ぐ
				repo.saveRun({
					...row,
					initialCash,
					account: newAccount(initialCash, row.account.seq),
					resetAt: t,
				});
			});
			return okRun(strategyId);
		},

		orders(filter, limit) {
			const f = runFilter(filter);
			return f ? repo.orders(f, limit) : [];
		},

		orderSummary(filter) {
			const f = runFilter(filter);
			return f ? repo.orderSummary(f) : { count: 0, realizedPnl: 0 };
		},

		performance(strategyId) {
			const found = accountOf(strategyId);
			if (!found) return null;
			const { row } = found;
			const t = now();
			// ドローダウンは1時間足の終値で追う（1分足では長く運用したときに重いため）
			const hour = TIMEFRAME_MS["1h"];
			const prices = marketData
				.loadCandles("1h", candleStart(row.resetAt, "1h"), t)
				.map((c) => ({ time: c.time + hour, price: c.close }));
			return tradingPerformance({
				instrument: marketData.instrument,
				initialCash: row.initialCash,
				resetAt: row.resetAt,
				now: t,
				cash: row.account.cash,
				position: row.account.position,
				price: currentPrice(market()),
				fills: repo.filledSince(row.id, row.resetAt),
				prices,
				// ガチホの起点は、リセットした時刻を含む1分足（まだ無ければ1時間以内で最初の1分足）の始値
				basePrice:
					marketData.loadCandles(
						"1m",
						candleStart(row.resetAt, "1m"),
						Math.min(t, candleStart(row.resetAt, "1m") + hour),
					)[0]?.open ?? null,
			});
		},

		order(strategyId, id) {
			const row = repo.runOf(strategyId);
			const order = row ? repo.order(row.id, id) : null;
			if (!order) return null;
			return {
				order,
				decision:
					order.decisionId === null ? null : repo.decision(order.decisionId),
			};
		},

		strategyLock(strategyId) {
			const row = repo.runOf(strategyId);
			return row ? lockOf(row) : null;
		},
	};
}
