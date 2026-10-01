// 自動取引の常駐実行。受信した約定で仮想注文の約定を決め、次の判定時刻に戦略を評価する。
// 状態（口座・未約定の注文・戦略の state・次の判定時刻）はすべて DB に置き、再起動しても続きから動く

import type {
	Account,
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
	TradingMode,
	TradingResult,
	TradingService,
} from "./types";

/** ペーパーの注文の id の頭につける文字 */
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
	strategies: Pick<StrategyService, "get" | "active">;
	judgments: Pick<JudgmentService, "current">;
	marketData: Pick<
		MarketDataRepository,
		"candlesBefore" | "loadCandles" | "lastCandle"
	>;
	market: () => LiveMarket;
	now?: () => number;
	fees?: FeeRates;
}): TradingEngine {
	// フェーズ4ではペーパーだけ動かす
	const mode: TradingMode = "paper";

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
		changed: readonly TradeOrder[],
		origin: { decisionId: number | null; strategy: StoredStrategy | null },
	) => {
		repo.saveOrders(mode, changed, {
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

	const evaluate = (t: number) => {
		const row = repo.autoTrading();
		if (!row.enabled || row.nextEvalAt === null) return;
		if (t < row.nextEvalAt && !row.reevaluate) return;
		const live = market();
		// 収集が止まっている間は判定しない（古い価格で注文しないため）。復帰したら過ぎた判定を1回だけ行う
		if (live.status.state !== "running" || !live.latestTrade) return;
		const s = row.strategyId === null ? null : strategies.get(row.strategyId);
		if (!s) {
			// 動かしている戦略が消えたら続けられないので止める。未約定の注文は残す
			console.error("trading: running strategy not found", row.strategyId);
			repo.saveAutoTrading({
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
		repo.transaction(() => {
			const expired = expireOrders(repo.account(mode, t).account, t);
			saveChanges(expired.changed, { decisionId: null, strategy: null });
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
				mode,
				{ id: s.id, name: s.name },
				out.decision,
				values,
			);
			saveChanges(out.changed, { decisionId, strategy: s });
			repo.saveAccount(mode, out.account);
			repo.saveAutoTrading({
				...row,
				state: out.state,
				nextEvalAt: out.nextEvalAt,
				reevaluate: false,
			});
		});
	};

	/** 資産の評価に使う今の価格。収集が止まっていれば保存済みの最後の1分足の終値 */
	const currentPrice = (live: LiveMarket): number | null =>
		live.latestTrade?.price ?? marketData.lastCandle("1m")?.close ?? null;

	const status = (): AutoTradingStatus => {
		const t = now();
		const row = repo.autoTrading();
		const s = row.enabled
			? row.strategyId === null
				? null
				: strategies.get(row.strategyId)
			: strategies.active();
		const a = repo.account(row.mode, t);
		const live = market();
		// 保有はオフにしても口座に残り、オンにし直すと同じ戦略で売るため、保有がある間も止める
		const strategyLock = row.enabled
			? "running"
			: a.account.lots.length > 0 || a.account.openOrders.length > 0
				? "holding"
				: null;
		return {
			enabled: row.enabled,
			mode: row.mode,
			strategy: s ? { id: s.id, name: s.name } : null,
			nextEvalAt: row.enabled ? row.nextEvalAt : s ? firstEvalAt(s, t) : null,
			startedAt: row.enabled ? row.startedAt : null,
			waitingForMarket:
				row.enabled &&
				(live.status.state !== "running" || live.latestTrade === null),
			dailyLoss: {
				loss: Math.max(0, -realizedPnlOn(a.account, t)),
				limit: s?.params.dailyLossLimit ?? null,
				blocked:
					dailyLossBlock(a.account, t, s?.params.dailyLossLimit ?? null) !==
					null,
			},
			strategyLock,
			account: {
				mode: row.mode,
				initialCash: a.initialCash,
				cash: a.account.cash,
				position: a.account.position,
				lots: publicLots(a.account.lots),
				openOrderCount: a.account.openOrders.length,
				resetAt: a.resetAt,
				equity: equityOf(
					a.account.cash,
					a.account.position,
					currentPrice(live),
				),
			},
		};
	};

	const ok = (): TradingResult => ({ ok: true, status: status() });

	return {
		onTrades(trades) {
			if (trades.length === 0) return;
			const t = now();
			repo.transaction(() => {
				let { account } = repo.account(mode, t);
				if (account.openOrders.length === 0) return;
				let filled = false;
				const sorted = [...trades].sort(
					(a, b) => a.time - b.time || a.id - b.id,
				);
				for (const trade of sorted) {
					if (account.openOrders.length === 0) break;
					// 期限を過ぎてから届いた約定では約定させない
					const expired = expireOrders(account, trade.time);
					saveChanges(expired.changed, { decisionId: null, strategy: null });
					const out = settleFills(
						expired.account,
						(o) => tradeFillPrice(o, trade),
						trade.time,
						fees,
					);
					saveChanges(out.changed, { decisionId: null, strategy: null });
					account = out.account;
					filled ||= out.filled;
				}
				repo.saveAccount(mode, account);
				if (filled) {
					const row = repo.autoTrading();
					// 自分の注文が約定したら、次の見回りで評価し直す（バックテストで約定した足の終わりに判定するのと揃える）
					if (row.enabled) repo.saveAutoTrading({ ...row, reevaluate: true });
				}
			});
		},

		tick() {
			const t = now();
			try {
				repo.transaction(() => {
					const { account } = repo.account(mode, t);
					const expired = expireOrders(account, t);
					if (expired.changed.length === 0) return;
					saveChanges(expired.changed, { decisionId: null, strategy: null });
					repo.saveAccount(mode, expired.account);
				});
				evaluate(t);
			} catch (e) {
				console.error("trading: tick failed", e);
			}
		},

		status,

		start(requested) {
			if (requested !== "paper") {
				return {
					ok: false,
					error: {
						kind: "unsupported_mode",
						message: "ライブはまだ選べない（フェーズ5で有効にする）",
					},
				};
			}
			const row = repo.autoTrading();
			if (row.enabled) {
				return {
					ok: false,
					error: { kind: "running", message: "自動取引は既に稼働中" },
				};
			}
			const s = strategies.active();
			if (!s) {
				return {
					ok: false,
					error: { kind: "no_strategy", message: "運用する戦略を選ぶ" },
				};
			}
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
			repo.saveAutoTrading({
				enabled: true,
				mode: requested,
				strategyId: s.id,
				state: null,
				nextEvalAt: firstEvalAt(s, t),
				reevaluate: false,
				startedAt: t,
			});
			return ok();
		},

		stop() {
			const row = repo.autoTrading();
			if (!row.enabled) {
				return {
					ok: false,
					error: { kind: "not_running", message: "自動取引は既に停止中" },
				};
			}
			repo.saveAutoTrading({
				...row,
				enabled: false,
				nextEvalAt: null,
				reevaluate: false,
			});
			return ok();
		},

		reset(initialCash) {
			if (!Number.isSafeInteger(initialCash) || initialCash < 1) {
				return {
					ok: false,
					error: {
						kind: "invalid_cash",
						message: "開始時の資金は 1 円以上の整数で入れる",
					},
				};
			}
			const row = repo.autoTrading();
			if (row.enabled) {
				return {
					ok: false,
					error: {
						kind: "running",
						message: "リセットは自動取引を停止してから行う",
					},
				};
			}
			const t = now();
			repo.transaction(() => {
				const { account } = repo.account(row.mode, t);
				const canceled = cancelAll(account, t, "口座のリセットで取消");
				saveChanges(canceled.changed, { decisionId: null, strategy: null });
				// 注文の id が過去の記録と重ならないよう、通し番号は引き継ぐ
				repo.resetAccount(
					row.mode,
					initialCash,
					newAccount(initialCash, account.seq),
					t,
				);
			});
			return ok();
		},

		orders: (filter, limit) => repo.orders(filter, limit),

		orderSummary: (filter) => repo.orderSummary(filter),

		performance(m) {
			const t = now();
			const a = repo.account(m, t);
			// ドローダウンは1時間足の終値で追う（1分足では長く運用したときに重いため）
			const hour = TIMEFRAME_MS["1h"];
			const prices = marketData
				.loadCandles("1h", candleStart(a.resetAt, "1h"), t)
				.map((c) => ({ time: c.time + hour, price: c.close }));
			return tradingPerformance({
				initialCash: a.initialCash,
				resetAt: a.resetAt,
				now: t,
				cash: a.account.cash,
				position: a.account.position,
				price: currentPrice(market()),
				fills: repo.filledSince(m, a.resetAt),
				prices,
				// ガチホの起点は、リセットした時刻を含む1分足（まだ無ければ1時間以内で最初の1分足）の始値
				basePrice:
					marketData.loadCandles(
						"1m",
						candleStart(a.resetAt, "1m"),
						Math.min(t, candleStart(a.resetAt, "1m") + hour),
					)[0]?.open ?? null,
			});
		},

		order(m, id) {
			const order = repo.order(m, id);
			if (!order) return null;
			return {
				order,
				decision:
					order.decisionId === null ? null : repo.decision(order.decisionId),
			};
		},
	};
}
