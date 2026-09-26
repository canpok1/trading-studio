import type {
	BacktestRun,
	StoredStrategy,
	TimeframeCoverage,
} from "@trading-studio/backend";
import type { ConditionSet, Gap, Timeframe } from "@trading-studio/core";
import {
	chooseStepTimeframe,
	conditionStrategy,
	isCoarser,
	parseConditionSet,
	percentToPpm,
	ppmToPercent,
	TIMEFRAME_LABELS,
	TIMEFRAME_MS,
	validateConditionSet,
} from "@trading-studio/core";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { useApi } from "../api";
import { NumberInput } from "../components/NumberInput";
import { Page } from "../components/Page";
import { EmptyState, ErrorState, LoadingCard } from "../components/States";
import {
	ConditionGroups,
	FrequencyCard,
	OrderSizeCard,
} from "../components/strategy/ConditionEditor";
import { Button, buttonClass, Card, Note, ProgressBar } from "../components/ui";
import {
	formatDate,
	formatDateTime,
	fromDateInputValue,
	toDateInputValue,
} from "../format";
import { useBacktestJob } from "../lib/backtest-job";
import { stepLimitedText } from "../lib/condition-text";
import { formatInt, formatSignedPercent } from "../lib/number";
import { errorMessage, readJson, useAsync } from "../lib/useAsync";

const DAY = 86_400_000;
const DEFAULT_CASH = 2_000_000;
const DEFAULT_FEE_PPM = 1000;
const STORAGE_KEY = "backtest-draft";

/** 実行条件の下書き。試しに変えた条件は画面を離れてもブラウザに残す */
export type BacktestDraft = {
	strategyId: number | null;
	params: ConditionSet;
	/** JST の日付（終了日を含む）。null はデータの最後から1か月 */
	fromDate: string | null;
	toDate: string | null;
	initialCash: number;
	fees: { limitPpm: number; marketPpm: number };
};

function loadDraft(): BacktestDraft | null {
	try {
		const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as
			| (BacktestDraft & { params: unknown })
			| null;
		const params = v && parseConditionSet(v.params);
		if (!v || !params) return null;
		return { ...v, params };
	} catch {
		return null;
	}
}

function saveDraft(d: BacktestDraft): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
	} catch {
		// 保存できない環境では、この画面を開いている間だけ効く
	}
}

const PRESETS = [
	["2w", "直近2週", 14],
	["1m", "直近1か月", 30],
	["3m", "直近3か月", 90],
] as const;

type Problem =
	| { kind: "gaps"; gaps: Gap[]; gapCount: number; missingBars: number }
	| { kind: "message"; text: string };

type Data = {
	strategies: StoredStrategy[];
	coverage: TimeframeCoverage[];
	runs: BacktestRun[];
	latest: number | null;
	/** AI 判定の採点の記録の始まり。まだ無ければ null */
	firstScoredAt: number | null;
};

export function BacktestRunPage() {
	const api = useApi();
	const location = useLocation();
	const [search] = useSearchParams();
	const navigate = useNavigate();
	const job = useBacktestJob();

	const load = useCallback(async (): Promise<Data> => {
		const [s, c, r, l, j] = await Promise.all([
			api.api.strategies
				.$get()
				.then((res) => readJson<{ strategies: StoredStrategy[] }>(res)),
			api.api.data.coverage
				.$get()
				.then((res) => readJson<{ timeframes: TimeframeCoverage[] }>(res)),
			api.api.backtests
				.$get()
				.then((res) => readJson<{ runs: BacktestRun[] }>(res)),
			api.api.data.latest
				.$get()
				.then((res) => readJson<{ latest: { close: number } | null }>(res)),
			api.api.judgments.current
				.$get()
				.then((res) => readJson<{ firstScoredAt: number | null }>(res)),
		]);
		return {
			strategies: s.strategies,
			coverage: c.timeframes,
			runs: r.runs,
			latest: l.latest?.close ?? null,
			firstScoredAt: j.firstScoredAt,
		};
	}, [api]);
	const { state, reload } = useAsync(load);

	// 実行が終わったら一覧を読み直す
	const runningId = job.running?.id ?? null;
	const prevRunning = useRef(runningId);
	useEffect(() => {
		if (prevRunning.current !== null && runningId === null) reload();
		prevRunning.current = runningId;
	}, [runningId, reload]);

	const [draft, setDraftState] = useState<BacktestDraft | null>(null);
	const setDraft = useCallback((d: BacktestDraft) => {
		setDraftState(d);
		saveDraft(d);
	}, []);

	// 下書きの初期値: 他の画面から渡された条件 > ブラウザに残した下書き > 最初の戦略
	const strategies = state.kind === "ok" ? state.data.strategies : null;
	useEffect(() => {
		if (!strategies || draft) return;
		const passed = location.state as Partial<BacktestDraft> | null;
		const passedParams = passed?.params && parseConditionSet(passed.params);
		const sid = Number(search.get("strategy"));
		const base = loadDraft();
		const first = strategies[0];
		if (passedParams) {
			setDraft({
				strategyId: strategies.some((s) => s.id === sid) ? sid : null,
				params: passedParams,
				fromDate: passed?.fromDate ?? base?.fromDate ?? null,
				toDate: passed?.toDate ?? base?.toDate ?? null,
				initialCash: passed?.initialCash ?? base?.initialCash ?? DEFAULT_CASH,
				fees: passed?.fees ??
					base?.fees ?? {
						limitPpm: DEFAULT_FEE_PPM,
						marketPpm: DEFAULT_FEE_PPM,
					},
			});
			// 再読み込みで同じ条件に戻さないよう、渡された条件を消す
			navigate(location.pathname, { replace: true, state: null });
		} else if (base) {
			const exists = strategies.some((s) => s.id === base.strategyId);
			setDraft({ ...base, strategyId: exists ? base.strategyId : null });
		} else if (first) {
			setDraft({
				strategyId: first.id,
				params: first.params,
				fromDate: null,
				toDate: null,
				initialCash: DEFAULT_CASH,
				fees: { limitPpm: DEFAULT_FEE_PPM, marketPpm: DEFAULT_FEE_PPM },
			});
		}
	}, [strategies, draft, location, search, navigate, setDraft]);

	if (
		state.kind === "loading" ||
		(state.kind === "ok" && !draft && strategies?.length)
	) {
		return (
			<Page title="バックテスト">
				<LoadingCard />
			</Page>
		);
	}
	if (state.kind === "error") {
		return (
			<Page title="バックテスト">
				<Card>
					<ErrorState
						what={`読み込めなかった（${state.message}）`}
						next="サーバーが動いているか確かめてから、もう一度読み込む"
						action={<Button onClick={reload}>もう一度読み込む</Button>}
					/>
				</Card>
			</Page>
		);
	}
	const { coverage, runs } = state.data;
	if (!coverage.some((c) => c.importedCount > 0)) {
		return (
			<Page title="バックテスト">
				<Card>
					<EmptyState
						title="過去データがまだない"
						description="バックテストには取り込み済みの CSV データが必要。"
						action={
							<Link to="/data" className={buttonClass("primary")}>
								過去データを取り込む
							</Link>
						}
					/>
				</Card>
			</Page>
		);
	}
	if (!draft) {
		return (
			<Page title="バックテスト">
				<Card>
					<EmptyState
						title="戦略がまだない"
						description="戦略設定で戦略を作ってから実行する。"
						action={
							<Link to="/strategies" className={buttonClass("primary")}>
								戦略を作る
							</Link>
						}
					/>
				</Card>
			</Page>
		);
	}
	return (
		<RunForm
			draft={draft}
			setDraft={setDraft}
			strategies={state.data.strategies}
			coverage={coverage}
			runs={runs}
			latest={state.data.latest}
			firstScoredAt={state.data.firstScoredAt}
		/>
	);
}

function RunForm({
	draft,
	setDraft,
	strategies,
	coverage,
	runs,
	latest,
	firstScoredAt,
}: {
	draft: BacktestDraft;
	setDraft: (d: BacktestDraft) => void;
	strategies: StoredStrategy[];
	coverage: TimeframeCoverage[];
	runs: BacktestRun[];
	latest: number | null;
	firstScoredAt: number | null;
}) {
	const api = useApi();
	const job = useBacktestJob();
	const [problem, setProblem] = useState<Problem | null>(null);
	const [busy, setBusy] = useState(false);
	const ids = { strategy: useId(), from: useId(), to: useId(), cash: useId() };

	const p = draft.params;
	const tf = p.timeframe;
	const tfMs = TIMEFRAME_MS[tf];
	const saved = strategies.find((s) => s.id === draft.strategyId) ?? null;
	const edited =
		saved !== null && JSON.stringify(saved.params) !== JSON.stringify(p);
	const errors = useMemo(() => validateConditionSet(p), [p]);

	// 期間。未指定ならこの粒度のデータの最後から1か月
	const cov = coverage.find((c) => c.timeframe === tf);
	const dataEnd = cov?.lastTime != null ? cov.lastTime + tfMs : null;
	const defaultTo =
		dataEnd !== null
			? toDateInputValue(dataEnd - 1)
			: toDateInputValue(Date.now());
	const toDate = draft.toDate ?? defaultTo;
	const toMs = (fromDateInputValue(toDate) ?? 0) + DAY;
	const fromDate = draft.fromDate ?? toDateInputValue(toMs - 30 * DAY);
	const fromMs = fromDateInputValue(fromDate) ?? 0;

	// 判定に使う足。期間に取り込んだ最も細かい足までしか細かくできない。選び方はサーバーに合わせるため問い合わせる
	const [usable, setUsable] = useState<{
		key: string;
		timeframes: Timeframe[];
	} | null>(null);
	const usableKey = `${fromMs}:${toMs}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: 期間が変わったときだけ問い合わせる
	useEffect(() => {
		let alive = true;
		api.api.data["usable-timeframes"]
			.$get({ query: { from: String(fromMs), to: String(toMs) } })
			.then((res) => readJson<{ timeframes: Timeframe[] }>(res))
			.then((r) => {
				if (alive) setUsable({ key: usableKey, timeframes: r.timeframes });
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [usableKey]);
	const finest =
		usable?.key === usableKey ? (usable.timeframes[0] ?? null) : null;
	const step =
		finest && !isCoarser(finest, tf) ? chooseStepTimeframe(p, finest) : null;

	// AI 判定の条件があれば、評価のたびに記録済みの採点から判定を作る。記録が始まる前は実行できない
	const usesJudgments = conditionStrategy.requiredJudges(p).length > 0;
	const judgmentError = !usesJudgments
		? null
		: firstScoredAt === null
			? "AI 判定の条件があるが、ニュースの採点の記録がまだ無いため実行できない"
			: fromMs < firstScoredAt
				? `AI 判定の記録は ${formatDateTime(firstScoredAt)} から。開始をこの日時以降にすると実行できる`
				: null;

	const bars = useMemo(() => {
		if (!cov || cov.firstTime === null || cov.lastTime === null) return 0;
		const a = Math.max(fromMs, cov.firstTime);
		const b = Math.min(toMs, cov.lastTime + tfMs);
		if (b <= a) return 0;
		const slots = Math.ceil((b - a) / tfMs);
		const missing = cov.gaps
			.filter((g) => g.from < b && g.to > a)
			.reduce(
				(n, g) =>
					n + Math.ceil((Math.min(g.to, b) - Math.max(g.from, a)) / tfMs),
				0,
			);
		return Math.max(0, slots - missing);
	}, [cov, fromMs, toMs, tfMs]);

	const periodError = fromMs >= toMs ? "終了は開始以降の日にする" : null;
	const cashError =
		Number.isSafeInteger(draft.initialCash) && draft.initialCash > 0
			? null
			: "1 円以上の整数で入れる";
	const feeError = (v: number) =>
		Number.isSafeInteger(v) && v >= 0 && v <= 100_000
			? null
			: "0〜10% の範囲で入れる";
	const hasErr =
		errors.length > 0 ||
		periodError !== null ||
		cashError !== null ||
		feeError(draft.fees.limitPpm) !== null ||
		feeError(draft.fees.marketPpm) !== null;

	const update = (patch: Partial<BacktestDraft>) => {
		setProblem(null);
		setDraft({ ...draft, ...patch });
	};

	const run = async (skipGaps: boolean) => {
		setBusy(true);
		setProblem(null);
		job.clearFinished();
		try {
			const res = await api.api.backtests.$post({
				json: {
					strategyId: draft.strategyId,
					params: p,
					from: fromMs,
					to: toMs,
					initialCash: draft.initialCash,
					fees: draft.fees,
					skipGaps,
				},
			});
			const body = (await res.json()) as {
				run?: BacktestRun;
				kind?: string;
				message?: string;
				gaps?: Gap[];
				gapCount?: number;
				missingBars?: number;
			};
			if (res.ok && body.run) {
				job.track(body.run);
			} else if (body.kind === "gaps") {
				setProblem({
					kind: "gaps",
					gaps: body.gaps ?? [],
					gapCount: body.gapCount ?? 0,
					missingBars: body.missingBars ?? 0,
				});
			} else if (body.kind === "busy" && body.run) {
				job.track(body.run);
				setProblem({ kind: "message", text: body.message ?? "実行中" });
			} else {
				setProblem({
					kind: "message",
					text: body.message ?? `実行できなかった（HTTP ${res.status}）`,
				});
			}
		} catch (e) {
			setProblem({
				kind: "message",
				text: `実行できなかった: ${errorMessage(e)}`,
			});
		} finally {
			setBusy(false);
		}
	};

	const cancel = async () => {
		if (!job.running) return;
		await api.api.backtests[":id"].cancel
			.$post({ param: { id: String(job.running.id) } })
			.catch(() => {});
	};

	const editor = {
		params: p,
		onChange: (params: ConditionSet) => update({ params }),
		errors,
	};
	const running = job.running;
	const last =
		job.finished && job.finished.status !== "done" ? job.finished : null;

	return (
		<Page
			title="バックテスト"
			description="戦略と条件を選んで、取り込んだ CSV の過去データで模擬売買する"
		>
			<div className="flex flex-col gap-3.5 lg:grid lg:grid-cols-2 lg:items-start">
				<div className="contents lg:flex lg:flex-col lg:gap-3.5">
					<Card className="flex flex-col gap-2">
						<label htmlFor={ids.strategy} className="text-[13px] font-semibold">
							戦略
						</label>
						<select
							id={ids.strategy}
							value={draft.strategyId ?? ""}
							onChange={(e) => {
								const s = strategies.find(
									(x) => x.id === Number(e.target.value),
								);
								if (s) update({ strategyId: s.id, params: s.params });
							}}
							className="h-12 rounded-[10px] border border-line bg-surface px-3 text-[15px] font-semibold"
						>
							{draft.strategyId === null && (
								<option value="">（保存していない条件）</option>
							)}
							{strategies.map((s) => (
								<option key={s.id} value={s.id}>
									{s.name}
								</option>
							))}
						</select>
						<div className="flex items-start justify-between gap-2">
							<p className="text-xs text-text-2">
								{edited
									? "保存済みの条件から変えて試している。戦略には保存されない。"
									: "保存済みの条件で試す。ここで変えても戦略には保存されない。"}
							</p>
							{edited && saved && (
								<Button
									variant="link"
									className="shrink-0"
									onClick={() => update({ params: saved.params })}
								>
									保存済みに戻す
								</Button>
							)}
						</div>
					</Card>
					<Card className="flex flex-col gap-3.5">
						<h2 className="text-[15px] font-bold">期間と資金</h2>
						<div className="flex flex-wrap gap-2">
							{PRESETS.map(([k, label, days]) => {
								return (
									<button
										key={k}
										type="button"
										aria-pressed={
											toDate === defaultTo && fromMs === toMs - days * DAY
										}
										onClick={() =>
											update({
												toDate: defaultTo,
												fromDate: toDateInputValue(
													(fromDateInputValue(defaultTo) ?? 0) +
														DAY -
														days * DAY,
												),
											})
										}
										className="h-8 rounded-full border border-line px-3 text-xs font-semibold text-text-2 aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-white dark:aria-pressed:text-accent-ink"
									>
										{label}
									</button>
								);
							})}
						</div>
						<div className="grid grid-cols-[minmax(0,1fr)_20px_minmax(0,1fr)] items-end gap-1.5">
							<div className="flex flex-col gap-1">
								<label htmlFor={ids.from} className="text-xs text-text-2">
									開始
								</label>
								<input
									id={ids.from}
									type="date"
									value={fromDate}
									onChange={(e) =>
										e.target.value &&
										update({ fromDate: e.target.value, toDate })
									}
									className="num h-11 min-w-0 rounded-[10px] border border-line bg-surface px-2 text-sm"
								/>
							</div>
							<span className="pb-3 text-center text-text-2">〜</span>
							<div className="flex flex-col gap-1">
								<label htmlFor={ids.to} className="text-xs text-text-2">
									終了
								</label>
								<input
									id={ids.to}
									type="date"
									value={toDate}
									onChange={(e) =>
										e.target.value &&
										update({ toDate: e.target.value, fromDate })
									}
									className="num h-11 min-w-0 rounded-[10px] border border-line bg-surface px-2 text-sm"
								/>
							</div>
						</div>
						{periodError && (
							<span className="text-xs font-semibold text-loss">
								{periodError}
							</span>
						)}
						<CoverageBar cov={cov} from={fromMs} to={toMs} />
						<div className="flex flex-col gap-1">
							<span className="text-[13px] font-semibold">足の粒度</span>
							<span className="num text-sm">
								{TIMEFRAME_LABELS[tf]}（戦略の粒度） · {formatInt(bars)} 本
								{step && step.timeframe !== tf
									? ` · ${TIMEFRAME_LABELS[step.timeframe]}で判定`
									: ""}
								{usesJudgments && " · 判定履歴を使う"}
							</span>
							{usesJudgments && firstScoredAt !== null && (
								<span className="num text-xs text-text-2">
									AI 判定の記録の開始: {formatDateTime(firstScoredAt)}
								</span>
							)}
						</div>
						{step?.limited && <Note>{stepLimitedText(step.timeframe)}</Note>}
						{judgmentError && (
							<span role="alert" className="text-xs font-semibold text-loss">
								{judgmentError}
							</span>
						)}
						<div className="flex flex-col gap-1.5">
							<label htmlFor={ids.cash} className="text-[13px] font-semibold">
								初期資金（円）
							</label>
							<NumberInput
								id={ids.cash}
								value={draft.initialCash}
								onChange={(initialCash) => update({ initialCash })}
								format={formatInt}
								inputMode="numeric"
								invalid={cashError !== null}
								className="h-11 text-left text-[15px]"
							/>
							{cashError && (
								<span className="text-xs font-semibold text-loss">
									{cashError}
								</span>
							)}
						</div>
						<fieldset className="flex flex-col gap-1.5">
							<legend className="mb-1.5 text-[13px] font-semibold">
								手数料率
							</legend>
							<div className="grid grid-cols-2 gap-2">
								{(
									[
										["limitPpm", "指値"],
										["marketPpm", "成行"],
									] as const
								).map(([k, label]) => (
									<div key={k} className="flex items-center gap-1.5 text-sm">
										<span aria-hidden="true" className="shrink-0">
											{label}
										</span>
										<NumberInput
											value={draft.fees[k]}
											onChange={(v) =>
												update({ fees: { ...draft.fees, [k]: v } })
											}
											format={formatPercent}
											parse={parsePercent}
											invalid={feeError(draft.fees[k]) !== null}
											aria-label={`${label}の手数料率（%）`}
											className="min-w-0 flex-1"
										/>
										<span>%</span>
									</div>
								))}
							</div>
							{(feeError(draft.fees.limitPpm) ??
								feeError(draft.fees.marketPpm)) && (
								<span className="text-xs font-semibold text-loss">
									0〜10% の範囲で入れる
								</span>
							)}
						</fieldset>
					</Card>
					<FrequencyCard {...editor} timeframeEditable={false} />
					<div className="order-1 lg:order-none">
						<OrderSizeCard {...editor} latestPrice={latest} />
					</div>
				</div>
				<div className="contents lg:flex lg:flex-col lg:gap-3.5">
					<ConditionGroups {...editor} />
				</div>
				<div className="order-2 flex flex-col gap-3.5 lg:col-span-2 lg:order-none">
					{running && (
						<Card className="flex flex-col gap-2.5">
							<div className="flex items-center justify-between">
								<strong>バックテストを実行中</strong>
								<span className="num font-semibold">
									{Math.round(running.progress * 100)}%
								</span>
							</div>
							<ProgressBar
								value={running.progress * 100}
								label="バックテストの進み具合"
							/>
							<p className="text-xs text-text-2">
								他の画面へ移っても処理は続く。終わると結果へ移動する。
							</p>
							<Button size="sm" className="self-start" onClick={cancel}>
								実行を中止
							</Button>
						</Card>
					)}
					{last && (
						<Note>
							<div className="flex items-start gap-2">
								<span className="flex-1">
									{last.status === "canceled"
										? "実行を中止した"
										: `バックテストが失敗した: ${last.error ?? "原因不明"}`}
								</span>
								<Button variant="link" onClick={job.clearFinished}>
									閉じる
								</Button>
							</div>
						</Note>
					)}
					{problem?.kind === "gaps" && (
						<div
							role="alert"
							className="flex flex-col gap-2 rounded-[10px] bg-warn px-3.5 py-3 text-xs"
						>
							<strong className="text-[13px]">
								期間内にデータの欠損がある
							</strong>
							<span className="num">
								{problem.gaps
									.slice(0, 3)
									.map(
										(g) =>
											`${formatDateTime(g.from)}〜${formatDateTime(g.to)}（${formatInt(g.missing)} 本）`,
									)
									.join("、")}
								{problem.gapCount > 3 && ` ほか ${problem.gapCount - 3} か所`}
								（合計 {formatInt(problem.missingBars)} 本）
							</span>
							<div className="flex flex-wrap items-center gap-2">
								<Button size="sm" disabled={busy} onClick={() => run(true)}>
									欠損を飛ばして実行
								</Button>
								<Button
									variant="link"
									onClick={() => {
										setProblem(null);
										document.getElementById(ids.from)?.focus();
									}}
								>
									期間を変える
								</Button>
							</div>
						</div>
					)}
					{problem?.kind === "message" && (
						<p role="alert" className="text-[13px] font-semibold text-loss">
							{problem.text}
						</p>
					)}
					<div className="sticky bottom-[calc(76px+env(safe-area-inset-bottom))] z-10 lg:bottom-4">
						<Button
							variant="primary"
							className="w-full shadow-lg"
							disabled={
								busy ||
								running !== null ||
								hasErr ||
								bars === 0 ||
								judgmentError !== null
							}
							onClick={() => run(false)}
						>
							{running
								? "実行中…"
								: hasErr
									? "入力を直すと実行できる"
									: bars === 0
										? "期間にデータが無い"
										: "バックテストを実行"}
						</Button>
					</div>
					<PastRuns runs={runs} />
				</div>
			</div>
		</Page>
	);
}

function formatPercent(ppm: number): string {
	return String(ppmToPercent(ppm));
}

function parsePercent(s: string): number {
	const t = s.trim();
	if (!/^\d+(\.\d+)?$/.test(t)) return Number.NaN;
	return percentToPpm(Number(t));
}

/** 取り込み済みの範囲と、選んだ期間・欠損を1本の帯で見せる */
function CoverageBar({
	cov,
	from,
	to,
}: {
	cov: TimeframeCoverage | undefined;
	from: number;
	to: number;
}) {
	if (!cov || cov.firstTime === null || cov.lastTime === null) {
		return <p className="text-xs text-text-2">この粒度のデータがまだない。</p>;
	}
	const start = Math.min(cov.firstTime, from);
	const end = Math.max(cov.lastTime, to);
	const span = Math.max(1, end - start);
	const pos = (t: number) => ((t - start) / span) * 100;
	return (
		<div className="flex flex-col gap-1.5">
			<div className="relative h-2.5 rounded bg-surface-2" aria-hidden="true">
				<div
					className="absolute inset-y-0 rounded bg-line"
					style={{
						left: `${pos(cov.firstTime)}%`,
						width: `${pos(cov.lastTime) - pos(cov.firstTime)}%`,
					}}
				/>
				{cov.gaps.map((g) => (
					<div
						key={g.from}
						className="absolute inset-y-0 bg-warn-strong"
						style={{
							left: `${pos(g.from)}%`,
							width: `max(2px, ${pos(g.to) - pos(g.from)}%)`,
						}}
					/>
				))}
				<div
					className="absolute -top-[3px] h-4 rounded-[3px] bg-accent opacity-80"
					style={{
						left: `${pos(from)}%`,
						width: `max(4px, ${pos(to) - pos(from)}%)`,
					}}
				/>
			</div>
			<div className="num flex justify-between text-xs text-text-2">
				<span>{formatDate(cov.firstTime)}</span>
				<span>取り込み済みの範囲</span>
				<span>{formatDate(cov.lastTime)}</span>
			</div>
		</div>
	);
}

function PastRuns({ runs }: { runs: BacktestRun[] }) {
	return (
		<section aria-label="過去の実行" className="mt-3 flex flex-col gap-2">
			<h2 className="text-[15px] font-bold">過去の実行</h2>
			<div className="overflow-hidden rounded-xl border border-line bg-surface">
				{runs.length === 0 && (
					<p className="px-4 py-3.5 text-xs text-text-2">
						まだ実行していない。条件を選んで実行すると、ここに並ぶ。
					</p>
				)}
				{runs.map((r) => {
					const pct = r.summary?.pnlPercent;
					return (
						<Link
							key={r.id}
							to={`/backtest/runs/${r.id}`}
							className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 hover:bg-surface-2"
						>
							<span className="flex min-w-0 flex-1 flex-col gap-0.5">
								<strong className="truncate text-sm">
									{r.strategyName} · {TIMEFRAME_LABELS[r.timeframe]}
								</strong>
								<span className="num text-xs text-text-2">
									{formatDate(r.from)}〜{formatDate(r.to - 1)} ·{" "}
									{formatDateTime(r.startedAt)} 実行
								</span>
							</span>
							{r.status === "done" && pct !== undefined ? (
								<span
									className={`num text-sm font-semibold ${pct >= 0 ? "text-profit" : "text-loss"}`}
								>
									{formatSignedPercent(pct)}
								</span>
							) : (
								<span className="text-xs text-text-2">
									{
										{
											running: "実行中",
											failed: "失敗",
											canceled: "中止",
											done: "",
										}[r.status]
									}
								</span>
							)}
						</Link>
					);
				})}
			</div>
		</section>
	);
}
