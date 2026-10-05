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
	realizedPnlOn,
	settleFills,
	TIMEFRAME_MS,
	TRADING_RUN_LIMITS,
	tradeFillPrice,
	validateConditionSet,
} from "@trading-studio/core";
import type { LiveMarket } from "../collector/types";
import type { JudgmentService } from "../judgments/types";
import type { MarketDataRepository } from "../market-data/repository";
import type { StoredStrategy, StrategyService } from "../strategies/types";
import { equityOf, tradingPerformance } from "./performance";
import type { TradingRepository } from "./repository";
import type {
	AutoTradingStatus,
	StrategyLock,
	TradingFailure,
	TradingResult,
	TradingRunRow,
	TradingService,
} from "./types";

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
	marketData,
	market,
	now = Date.now,
	fees = DEFAULT_FEE_RATES,
}: {
	repo: TradingRepository;
	strategies: Pick<StrategyService, "get">;
	judgments: Pick<JudgmentService, "current">;
	marketData: Pick<
		MarketDataRepository,
		"candlesBefore" | "loadCandles" | "lastCandle"
	>;
	market: () => LiveMarket;
	now?: () => number;
	fees?: FeeRates;
}): TradingEngine {
	repo.ensureRun(now());

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
		// 採点の記録が始まる前は判定を渡さない（データなし）
		const current = judgments.current();
		const values: Record<string, string> = {};
		if (
			current.firstScoredAt !== null &&
			current.time >= current.firstScoredAt
		) {
			for (const j of JUDGES) values[j] = current.results[j].value;
		}
		const expired = expireOrders(row.account, t);
		saveChanges(row, expired.changed, { decisionId: null, strategy: null });
		const out = decide({
			strategy: conditionStrategy,
			params: s.params,
			now: t,
			price: (live.latestTrade as MarketTrade).price,
			...candlesAt(s, t, live),
			judgments: Object.fromEntries(
				Object.entries(values).map(([judge, label]) => [
					judge,
					[{ judge, time: t, label }],
				]),
			),
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

	/** 戦略の切り替えを止めている理由。保有はオフにしても口座に残り、オンにし直すと同じ戦略で売るため、保有がある間も止める */
	const lockOf = (row: TradingRunRow): StrategyLock | null =>
		row.enabled
			? "running"
			: row.account.lots.length > 0 || row.account.openOrders.length > 0
				? "holding"
				: null;

	const statusOf = (
		row: TradingRunRow,
		t: number,
		live: LiveMarket,
	): AutoTradingStatus => {
		const s = row.strategyId === null ? null : strategies.get(row.strategyId);
		const a = row.account;
		return {
			id: row.id,
			name: row.name,
			enabled: row.enabled,
			mode: row.mode,
			strategy: s ? { id: s.id, name: s.name } : null,
			nextEvalAt: row.enabled ? row.nextEvalAt : s ? firstEvalAt(s, t) : null,
			startedAt: row.enabled ? row.startedAt : null,
			waitingForMarket:
				row.enabled &&
				(live.status.state !== "running" || live.latestTrade === null),
			dailyLoss: {
				loss: Math.max(0, -realizedPnlOn(a, t)),
				limit: s?.params.dailyLossLimit ?? null,
				blocked:
					dailyLossBlock(a, t, s?.params.dailyLossLimit ?? null) !== null,
			},
			strategyLock: lockOf(row),
			account: {
				initialCash: row.initialCash,
				cash: a.cash,
				position: a.position,
				lots: publicLots(a.lots),
				openOrderCount: a.openOrders.length,
				resetAt: row.resetAt,
				equity: equityOf(a.cash, a.position, currentPrice(live)),
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

	const okRun = (id: number): TradingResult => {
		const row = repo.run(id);
		return row
			? { ok: true, status: statusOf(row, now(), market()) }
			: fail("not_found", "運用が見つからない");
	};

	const notFound = () => fail("not_found", "運用が見つからない");

	/** 運用の id。読めなければ空にし、見回りを例外で止めない */
	const runIds = (): number[] => {
		try {
			return repo.runIds();
		} catch (e) {
			console.error("trading: runs unreadable", e);
			return [];
		}
	};

	const nameError = (name: string): string | null => {
		const n = name.trim();
		if (!n) return "名前を入れる";
		if (n.length > TRADING_RUN_LIMITS.name) {
			return `${TRADING_RUN_LIMITS.name} 文字以内にする`;
		}
		return null;
	};

	/** 戦略が選べるか。無ければ not_found */
	const strategyError = (id: number | null): string | null =>
		id === null || strategies.get(id) ? null : "戦略が見つからない";

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
			return repo.runs().map((r) => statusOf(r, t, live));
		},

		run(id) {
			const row = repo.run(id);
			return row ? statusOf(row, now(), market()) : null;
		},

		create(input) {
			const invalid = nameError(input.name);
			if (invalid) return fail("invalid_name", invalid);
			const noStrategy = strategyError(input.strategyId);
			if (noStrategy) return fail("not_found", noStrategy);
			const runs = repo.runs();
			if (runs.length >= TRADING_RUN_LIMITS.runs) {
				return fail("limit", `タブは ${TRADING_RUN_LIMITS.runs} つまで`);
			}
			if (input.mode === "live" && runs.some((r) => r.mode === "live")) {
				return fail("limit", "リアルのタブは1つまで（実口座は1つのため）");
			}
			const id = repo.createRun({ ...input, name: input.name.trim() }, now());
			return okRun(id);
		},

		update(id, input) {
			const row = repo.run(id);
			if (!row) return notFound();
			const next = { ...row };
			if (input.name !== undefined) {
				const invalid = nameError(input.name);
				if (invalid) return fail("invalid_name", invalid);
				next.name = input.name.trim();
			}
			if (
				input.strategyId !== undefined &&
				input.strategyId !== row.strategyId
			) {
				const noStrategy = strategyError(input.strategyId);
				if (noStrategy) return fail("not_found", noStrategy);
				const lock = lockOf(row);
				if (lock) {
					return fail(
						"locked",
						lock === "running"
							? "運用する戦略を変えるには先に自動取引を停止する"
							: "保有か未約定の注文がある間は運用する戦略を変えられない。売れるのを待つか、口座をリセットする",
					);
				}
				next.strategyId = input.strategyId;
			}
			repo.saveRun(next);
			return okRun(id);
		},

		remove(id) {
			const row = repo.run(id);
			if (!row) return notFound();
			if (row.enabled) {
				return fail("running", "タブを消すには先に自動取引を停止する");
			}
			if (repo.runs().length <= 1) {
				return fail("limit", "タブは最低1つ残す");
			}
			const t = now();
			repo.transaction(() => {
				const canceled = cancelAll(row.account, t, "タブの削除で取消");
				saveChanges(row, canceled.changed, {
					decisionId: null,
					strategy: null,
				});
				repo.saveRun({ ...row, account: canceled.account });
				repo.deleteRun(id, t);
			});
			return { ok: true };
		},

		start(id) {
			const row = repo.run(id);
			if (!row) return notFound();
			if (row.mode !== "paper") {
				return fail(
					"unsupported_mode",
					"リアルはまだ選べない（フェーズ5で有効にする）",
				);
			}
			if (row.enabled) return fail("running", "自動取引は既に稼働中");
			const s = row.strategyId === null ? null : strategies.get(row.strategyId);
			if (!s) return fail("no_strategy", "運用する戦略を選ぶ");
			const errors = validateConditionSet(s.params);
			if (errors.length > 0) {
				return {
					ok: false,
					error: {
						kind: "invalid_strategy",
						message: "運用する戦略の条件に足りないものがある",
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
			return okRun(id);
		},

		stop(id) {
			const row = repo.run(id);
			if (!row) return notFound();
			if (!row.enabled) return fail("not_running", "自動取引は既に停止中");
			repo.saveRun({
				...row,
				enabled: false,
				nextEvalAt: null,
				reevaluate: false,
			});
			return okRun(id);
		},

		reset(id, initialCash) {
			if (!Number.isSafeInteger(initialCash) || initialCash < 1) {
				return fail("invalid_cash", "開始時の資金は 1 円以上の整数で入れる");
			}
			const row = repo.run(id);
			if (!row) return notFound();
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
			return okRun(id);
		},

		orders: (filter, limit) => repo.orders(filter, limit),

		orderSummary: (filter) => repo.orderSummary(filter),

		performance(id) {
			const row = repo.run(id);
			if (!row) return null;
			const t = now();
			// ドローダウンは1時間足の終値で追う（1分足では長く運用したときに重いため）
			const hour = TIMEFRAME_MS["1h"];
			const prices = marketData
				.loadCandles("1h", candleStart(row.resetAt, "1h"), t)
				.map((c) => ({ time: c.time + hour, price: c.close }));
			return tradingPerformance({
				initialCash: row.initialCash,
				resetAt: row.resetAt,
				now: t,
				cash: row.account.cash,
				position: row.account.position,
				price: currentPrice(market()),
				fills: repo.filledSince(id, row.resetAt),
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

		order(runId, id) {
			const order = repo.order(runId, id);
			if (!order) return null;
			return {
				order,
				decision:
					order.decisionId === null ? null : repo.decision(order.decisionId),
			};
		},

		inUse: (strategyId) => repo.strategyIds().includes(strategyId),

		strategyLock(strategyId) {
			let lock: StrategyLock | null = null;
			for (const r of repo.runs()) {
				if (r.strategyId !== strategyId) continue;
				const l = lockOf(r);
				if (l === "running") return l;
				lock ??= l;
			}
			return lock;
		},
	};
}
