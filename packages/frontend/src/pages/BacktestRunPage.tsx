import type {
	BacktestRun,
	CriteriaVersion,
	Dataset,
	DatasetBlocker,
	DatasetRun,
	ListedSegment,
	RescoreCoverage,
	StoredStrategy,
	TimeframeCoverage,
} from "@trading-studio/backend";
import type {
	ConditionSet,
	ConditionSetChange,
	Gap,
	Timeframe,
} from "@trading-studio/core";
import {
	acceptsNoJudgment,
	candleTimeframes,
	chooseStepTimeframe,
	conditionStrategy,
	DEFAULT_CONDITION_TIMEFRAME,
	DEFAULT_FEE_RATES,
	historyShortfalls,
	isCoarser,
	parseConditionSet,
	percentToPpm,
	ppmToPercent,
	strategyTemplate,
	TEMPLATE_IDS,
	TIMEFRAME_LABELS,
	TIMEFRAME_MS,
	validateConditionSet,
} from "@trading-studio/core";
import type { ReactNode } from "react";
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
import { DatasetPicker } from "../components/backtest/DatasetPicker";
import {
	RescoreStatus,
	rescoreReady,
} from "../components/backtest/RescoreStatus";
import { RunHistory } from "../components/backtest/RunHistory";
import { Help } from "../components/Help";
import { Modal } from "../components/Modal";
import { NumberInput } from "../components/NumberInput";
import { Page } from "../components/Page";
import { EmptyState, ErrorState, LoadingCard } from "../components/States";
import {
	BuyRulesEditor,
	FrequencyCard,
	RiskLimitCard,
} from "../components/strategy/ConditionEditor";
import {
	Button,
	buttonClass,
	Card,
	Note,
	ProgressBar,
	Segmented,
	Tabs,
} from "../components/ui";
import {
	formatDate,
	formatDateTime,
	fromDateInputValue,
	toDateInputValue,
} from "../format";
import { useBacktestJob } from "../lib/backtest-job";
import { stepLimitedText } from "../lib/condition-text";
import { formatInt } from "../lib/number";
import { REGIME_RULE_TEXT, segmentName, segmentSummary } from "../lib/segment";
import { errorMessage, readJson, useAsync } from "../lib/useAsync";

const DAY = 86_400_000;
const DEFAULT_CASH = 2_000_000;
const STORAGE_KEY = "backtest-draft";
const NAME_MAX = 40;
export const BACKTEST_NAME_MAX = NAME_MAX;
const BLANK_NAME = "新しいバックテスト";

/** 条件をコピーしてきたテンプレート（ひな形か保存済みの戦略）。コピーした後は元と切り離す */
type Template = {
	/** ひな形は `t:<id>`、保存済みの戦略は `s:<id>` */
	key: string;
	label: string;
	/** ひな形の説明。テンプレートを選ぶモーダルに出す */
	description?: string;
	params: ConditionSet;
};

/** 実行条件の下書き。試しに変えた条件は画面を離れてもブラウザに残す */
export type BacktestDraft = {
	name: string;
	/** 適用したテンプレート。「戦略設定」の見出しの横に出す。結果から再実行したときは無い */
	template: Template | null;
	params: ConditionSet;
	/** AI アドバイスの改善版から来たとき、元の実行からの変更点。「戦略設定」の下に出す。閉じるかテンプレートを読み込むと消す */
	improvement?: { changes: ConditionSetChange[] } | null;
	/** JST の日付（終了日を含む）。null はデータの最後から1か月 */
	fromDate: string | null;
	toDate: string | null;
	initialCash: number;
	fees: { limitPpm: number; marketPpm: number };
	/** 市場評価に使う採点の基準の版。null・省略は運用どおり */
	criteriaVersion?: number | null;
	/** 期間の決め方。segment=相場データを選ぶ、dataset=データセットでまとめて実行する、range（省略）=日付で指定する */
	periodMode?: "segment" | "dataset" | "range";
	/** 選んだ相場データ。null・省略や消えた相場データは一番新しいもの */
	segmentId?: number | null;
	/** 選んだデータセット。null・省略や消えたデータセットは一覧の最初のもの */
	datasetId?: number | null;
};

/** 戦略と結び付いていた頃の下書き（名前もテンプレートも無く、strategyId を持つ）も読む */
function loadDraft(strategies: StoredStrategy[]): BacktestDraft | null {
	try {
		const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as
			| (Omit<BacktestDraft, "params" | "template"> & {
					params: unknown;
					template?: (Template & { params: unknown }) | null;
					strategyId?: number | null;
			  })
			| null;
		const params = v && parseConditionSet(v.params);
		if (!v || !params) return null;
		const tParams = v.template && parseConditionSet(v.template.params);
		const legacy = strategies.find((s) => s.id === v.strategyId);
		const template =
			v.template && tParams
				? { ...v.template, params: tParams }
				: legacy
					? strategyAsTemplate(legacy)
					: null;
		return {
			name: v.name ?? template?.label ?? BLANK_NAME,
			template,
			params,
			improvement: v.improvement ?? null,
			fromDate: v.fromDate,
			toDate: v.toDate,
			initialCash: v.initialCash,
			fees: v.fees,
			criteriaVersion: v.criteriaVersion ?? null,
			periodMode: v.periodMode ?? "range",
			segmentId: v.segmentId ?? null,
			datasetId: v.datasetId ?? null,
		};
	} catch {
		return null;
	}
}

const strategyAsTemplate = (s: StoredStrategy): Template => ({
	key: `s:${s.id}`,
	label: s.name,
	params: s.params,
});

function templates(strategies: StoredStrategy[]): Template[] {
	return [
		...TEMPLATE_IDS.map((id) => {
			const t = strategyTemplate(id);
			return {
				key: `t:${id}`,
				label: t.name,
				description: t.description,
				params: t.params,
			};
		}),
		...strategies.map(strategyAsTemplate),
	];
}

/** 初めて開いたときのバックテスト名。テンプレートを読み込み直しても名前は変えない */
const nameFor = (t: Template) => (t.key === "t:blank" ? BLANK_NAME : t.label);

function checkName(name: string): string | null {
	const n = name.trim();
	if (!n) return "名前を入れる";
	if (n.length > NAME_MAX) return `${NAME_MAX} 文字以内にする`;
	return null;
}

function saveDraft(d: BacktestDraft): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
	} catch {
		// 保存できない環境では、この画面を開いている間だけ効く
	}
}

/** 既定は「実行」。結果から再実行するときも「実行」に来る */
const TABS = [
	["run", "実行"],
	["history", "履歴"],
] as const;
type BacktestTab = (typeof TABS)[number][0];

const PERIOD_MODES = [
	["segment", "相場データ"],
	["dataset", "データセット"],
	["range", "期間を指定"],
] as const;

const PRESETS = [
	["2w", "直近2週", 14],
	["1m", "直近1か月", 30],
	["3m", "直近3か月", 90],
] as const;

type Problem =
	| { kind: "gaps"; gaps: Gap[]; gapCount: number; missingBars: number }
	| { kind: "message"; text: string }
	/** データセットに実行できない相場データがある */
	| { kind: "blocked"; blockers: DatasetBlocker[] };

type Data = {
	strategies: StoredStrategy[];
	coverage: TimeframeCoverage[];
	latest: number | null;
	/** AI 判定の採点の記録の始まり。まだ無ければ null */
	firstScoredAt: number | null;
	criteriaVersions: CriteriaVersion[];
	/** 新しい順 */
	segments: ListedSegment[];
	/** 名前の順 */
	datasets: Dataset[];
};

export function BacktestRunPage() {
	const api = useApi();
	const location = useLocation();
	const [search] = useSearchParams();
	const navigate = useNavigate();
	const job = useBacktestJob();

	const load = useCallback(async (): Promise<Data> => {
		const [s, c, l, j, cv, ds, dd] = await Promise.all([
			api.api.strategies
				.$get()
				.then((res) => readJson<{ strategies: StoredStrategy[] }>(res)),
			api.api.data.coverage
				.$get()
				.then((res) => readJson<{ timeframes: TimeframeCoverage[] }>(res)),
			api.api.data.latest
				.$get()
				.then((res) => readJson<{ latest: { close: number } | null }>(res)),
			api.api.judgments.current
				.$get()
				.then((res) => readJson<{ firstScoredAt: number | null }>(res)),
			api.api.scoring.criteria
				.$get()
				.then((res) => readJson<{ versions: CriteriaVersion[] }>(res)),
			api.api.segments
				.$get({ query: {} })
				.then((res) => readJson<{ segments: ListedSegment[] }>(res)),
			api.api.datasets
				.$get()
				.then((res) => readJson<{ datasets: Dataset[] }>(res)),
		]);
		return {
			strategies: s.strategies,
			coverage: c.timeframes,
			latest: l.latest?.close ?? null,
			firstScoredAt: j.firstScoredAt,
			criteriaVersions: cv.versions,
			segments: ds.segments,
			datasets: dd.datasets,
		};
	}, [api]);
	const { state, reload } = useAsync(load);

	// 実行が終わったら一覧を読み直す
	const runningId = job.running?.id ?? job.runningDataset?.id ?? null;
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

	// 下書きの初期値: 他の画面から渡された条件 > ブラウザに残した下書き > 最初の戦略かトレンド追随のひな形
	const strategies = state.kind === "ok" ? state.data.strategies : null;
	useEffect(() => {
		if (!strategies || draft) return;
		const passed = location.state as Partial<BacktestDraft> | null;
		const passedParams = passed?.params && parseConditionSet(passed.params);
		// 「戦略」の画面から、その戦略をテンプレートにして来た
		const from = strategies.find(
			(s) => s.id === Number(search.get("strategy")),
		);
		const template = from ? strategyAsTemplate(from) : null;
		const base = loadDraft(strategies);
		const first = strategies[0]
			? strategyAsTemplate(strategies[0])
			: (templates([]).find((t) => t.key === "t:trend") as Template);
		if (passedParams) {
			setDraft({
				name: passed?.name ?? template?.label ?? BLANK_NAME,
				template,
				params: passedParams,
				improvement: passed?.improvement ?? null,
				fromDate: passed?.fromDate ?? base?.fromDate ?? null,
				toDate: passed?.toDate ?? base?.toDate ?? null,
				initialCash: passed?.initialCash ?? base?.initialCash ?? DEFAULT_CASH,
				fees: passed?.fees ??
					base?.fees ?? {
						...DEFAULT_FEE_RATES,
					},
				criteriaVersion:
					passed?.criteriaVersion !== undefined
						? passed.criteriaVersion
						: (base?.criteriaVersion ?? null),
				periodMode: passed?.periodMode ?? base?.periodMode ?? "range",
				segmentId:
					passed?.segmentId !== undefined
						? passed.segmentId
						: (base?.segmentId ?? null),
				datasetId:
					passed?.datasetId !== undefined
						? passed.datasetId
						: (base?.datasetId ?? null),
			});
			// 再読み込みで同じ条件に戻さないよう、渡された条件を消す
			navigate(location.pathname, { replace: true, state: null });
		} else if (base) {
			setDraft(base);
		} else {
			setDraft({
				name: nameFor(first),
				template: first,
				params: first.params,
				fromDate: null,
				toDate: null,
				initialCash: DEFAULT_CASH,
				fees: { ...DEFAULT_FEE_RATES },
			});
		}
	}, [strategies, draft, location, search, navigate, setDraft]);

	// 履歴は実行の条件を作るためのデータを待たずに出す
	if (search.get("tab") === "history") {
		return (
			<BacktestFrame tab="history">
				<div role="tabpanel">
					<RunHistory />
				</div>
			</BacktestFrame>
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
	if (state.kind === "loading" || !draft) {
		return (
			<Page title="バックテスト">
				<LoadingCard />
			</Page>
		);
	}
	const { coverage } = state.data;
	if (!coverage.some((c) => c.importedCount > 0)) {
		return (
			<Page title="バックテスト">
				<Card>
					<EmptyState
						title="過去データがまだ無い"
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
	return (
		<RunForm
			draft={draft}
			setDraft={setDraft}
			strategies={state.data.strategies}
			coverage={coverage}
			latest={state.data.latest}
			firstScoredAt={state.data.firstScoredAt}
			criteriaVersions={state.data.criteriaVersions}
			segments={state.data.segments}
			datasets={state.data.datasets}
		/>
	);
}

function RunForm({
	draft,
	setDraft,
	strategies,
	coverage,
	latest,
	firstScoredAt: latestFirstScoredAt,
	criteriaVersions,
	segments,
	datasets: initialDatasets,
}: {
	draft: BacktestDraft;
	setDraft: (d: BacktestDraft) => void;
	strategies: StoredStrategy[];
	coverage: TimeframeCoverage[];
	latest: number | null;
	firstScoredAt: number | null;
	criteriaVersions: CriteriaVersion[];
	segments: ListedSegment[];
	datasets: Dataset[];
}) {
	const api = useApi();
	const job = useBacktestJob();
	const [problem, setProblem] = useState<Problem | null>(null);
	const [busy, setBusy] = useState(false);
	const [picking, setPicking] = useState(false);
	const ids = {
		name: useId(),
		from: useId(),
		to: useId(),
		cash: useId(),
		version: useId(),
		segment: useId(),
	};

	const p = draft.params;
	// 条件で使う足（細かい順）。期間・本数・取り込み済みの範囲は最も細かい足で見る。
	// 足を使う条件が無ければ、期間の既定は最も古くからある足で決め、本数は期間に使える最も細かい足で数える
	const needed = candleTimeframes(p);
	const periodTf =
		needed[0] ??
		coverage
			.filter((c) => c.firstTime !== null)
			.sort((a, b) => (a.firstTime as number) - (b.firstTime as number))[0]
			?.timeframe ??
		DEFAULT_CONDITION_TIMEFRAME;
	const choices = templates(strategies);
	// 保存済みの戦略は、選んだ後に編集されていれば今の条件へ戻す
	const template =
		draft.template &&
		(choices.find((t) => t.key === draft.template?.key) ?? draft.template);
	const edited =
		template !== null && JSON.stringify(template.params) !== JSON.stringify(p);
	const nameError = checkName(draft.name);
	const errors = useMemo(() => validateConditionSet(p), [p]);

	// 期間。未指定ならその足のデータの最後から1か月
	const periodCov = coverage.find((c) => c.timeframe === periodTf);
	const dataEnd =
		periodCov?.lastTime != null
			? periodCov.lastTime + TIMEFRAME_MS[periodTf]
			: null;
	const defaultTo =
		dataEnd !== null
			? toDateInputValue(dataEnd - 1)
			: toDateInputValue(Date.now());
	const toDate = draft.toDate ?? defaultTo;
	const rangeTo = (fromDateInputValue(toDate) ?? 0) + DAY;
	const fromDate = draft.fromDate ?? toDateInputValue(rangeTo - 30 * DAY);
	// 相場データを選ぶときは、その期間で実行する。まだ選んでいなければ一番新しいもの
	const bySegment = draft.periodMode === "segment";
	const segment = bySegment
		? draft.segmentId == null
			? (segments[0] ?? null)
			: (segments.find((d) => d.id === draft.segmentId) ?? null)
		: null;
	// データセットは相場データごとに実行するので、期間に依る確かめはサーバーが相場データごとに行う。
	// 足の数などの表示は、データセットの一番新しい相場データで出す
	const [datasets, setDatasets] = useState(initialDatasets);
	const byDataset = draft.periodMode === "dataset";
	const dataset = byDataset
		? (datasets.find((d) => d.id === draft.datasetId) ?? datasets[0] ?? null)
		: null;
	const datasetLatest = dataset?.segments[0] ?? null;
	const reloadDatasets = async (select: number | null) => {
		const r = await api.api.datasets
			.$get()
			.then((res) => readJson<{ datasets: Dataset[] }>(res));
		setDatasets(r.datasets);
		if (select !== null) update({ datasetId: select });
		else if (!r.datasets.some((d) => d.id === draft.datasetId)) {
			update({ datasetId: r.datasets[0]?.id ?? null });
		}
	};
	const periodSegment = segment ?? datasetLatest;
	const toMs = periodSegment ? periodSegment.to : rangeTo;
	// 古いニュースを消した後も、残した相場データはそのニュースを使えるので記録の始まりが違う
	const firstScoredAt = segment ? segment.firstScoredAt : latestFirstScoredAt;
	const fromMs = periodSegment
		? periodSegment.from
		: (fromDateInputValue(fromDate) ?? 0);
	const shortfalls = useMemo(
		() =>
			historyShortfalls(
				p,
				fromMs,
				Object.fromEntries(coverage.map((c) => [c.timeframe, c.firstTime])),
			),
		[p, fromMs, coverage],
	);

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
	const tf = needed[0] ?? finest ?? periodTf;
	const tfMs = TIMEFRAME_MS[tf];
	const cov = coverage.find((c) => c.timeframe === tf);
	const step =
		finest && !isCoarser(finest, tf) ? chooseStepTimeframe(p, finest) : null;

	// AI 判定の条件があれば、評価のたびに記録済みの採点から判定を作る。
	// 記録が始まる前はデータなしで、判定の条件のどれかで「データなし」を選んでいなければ実行できない
	const usesJudgments = conditionStrategy.requiredJudges(p).length > 0;
	const judgmentError =
		byDataset || !usesJudgments || acceptsNoJudgment(p)
			? null
			: firstScoredAt === null
				? "市場評価の条件があるが、ニュースの採点の記録がまだ無いため実行できない。市場評価の条件で「データなし」を選ぶと実行できる"
				: fromMs < firstScoredAt && segment
					? `市場評価の記録は ${formatDateTime(firstScoredAt)} から。この相場データはそれより前を含むため、市場評価の条件で「データなし」を選ぶと実行できる`
					: fromMs < firstScoredAt
						? `市場評価の記録は ${formatDateTime(firstScoredAt)} から。開始を ${formatDate(firstAllowedFrom(firstScoredAt))} 以降にするか、市場評価の条件で「データなし」を選ぶと実行できる`
						: null;

	// 版を選んだら、期間の市場評価に使う記事がすべてその版で採点されているときだけ実行できる。
	// 消した版を下書きに残していても運用どおりに戻す
	const criteriaVersion =
		usesJudgments &&
		criteriaVersions.some((v) => v.version === draft.criteriaVersion)
			? (draft.criteriaVersion ?? null)
			: null;
	const [rescore, setRescore] = useState<RescoreCoverage | null>(null);
	const rescoreBlocked =
		!byDataset &&
		criteriaVersion !== null &&
		(rescore === null || !rescoreReady(rescore));

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

	const periodError =
		byDataset && datasets.length === 0
			? "データセットがまだ無い。「新しく作る」で相場データを選んで作る"
			: byDataset && !datasetLatest
				? "このデータセットの相場データはすべて消えている。編集して選び直す"
				: bySegment && segments.length === 0
					? "相場データがまだ無い。1分足が2か月そろうと、次の月に入ってから作る。それまでは期間を指定する"
					: bySegment && !segment
						? "選んでいた相場データは消えている。選び直す"
						: fromMs >= toMs
							? "終了日は開始日以降にする"
							: null;
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
		nameError !== null ||
		periodError !== null ||
		cashError !== null ||
		feeError(draft.fees.limitPpm) !== null ||
		feeError(draft.fees.marketPpm) !== null;

	const update = (patch: Partial<BacktestDraft>) => {
		setProblem(null);
		setDraft({ ...draft, ...patch });
	};

	const runDataset = async (skipGaps: boolean) => {
		if (!dataset) return;
		setBusy(true);
		setProblem(null);
		job.clearFinished();
		try {
			const res = await api.api["dataset-runs"].$post({
				json: {
					datasetId: dataset.id,
					name: draft.name,
					params: p,
					initialCash: draft.initialCash,
					fees: draft.fees,
					skipGaps,
					criteriaVersion,
				},
			});
			const body = (await res.json()) as {
				run?: DatasetRun;
				kind?: string;
				message?: string;
				blockers?: DatasetBlocker[];
			};
			if (res.ok && body.run) {
				job.trackDataset(body.run);
			} else if (body.kind === "blocked") {
				setProblem({ kind: "blocked", blockers: body.blockers ?? [] });
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

	const run = async (skipGaps: boolean) => {
		if (byDataset) return runDataset(skipGaps);
		setBusy(true);
		setProblem(null);
		job.clearFinished();
		try {
			const res = await api.api.backtests.$post({
				json: {
					name: draft.name,
					params: p,
					from: fromMs,
					to: toMs,
					initialCash: draft.initialCash,
					fees: draft.fees,
					skipGaps,
					criteriaVersion,
					segmentId: segment?.id ?? null,
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
				await trackBusy(body.run);
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

	/** 実行中のものを追う。まとめた実行の一部なら、まとめた実行のほうを追う */
	const trackBusy = async (run: BacktestRun) => {
		if (run.datasetRunId === null) return job.track(run);
		const r = await api.api["dataset-runs"][":id"]
			.$get({ param: { id: String(run.datasetRunId) } })
			.then((res) => readJson<{ run: DatasetRun }>(res));
		if (r.run.status === "running") job.trackDataset(r.run);
	};

	const cancel = async () => {
		if (job.runningDataset) {
			await api.api["dataset-runs"][":id"].cancel
				.$post({ param: { id: String(job.runningDataset.id) } })
				.catch(() => {});
			return;
		}
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
	const runningDataset = job.runningDataset;
	const busyRunning = running !== null || runningDataset !== null;
	const last =
		job.finished && job.finished.status !== "done" ? job.finished : null;
	const lastDataset =
		job.finishedDataset && job.finishedDataset.status !== "done"
			? job.finishedDataset
			: null;

	return (
		<BacktestFrame tab="run">
			{/* 上段はバックテストの環境（PC は左に名前・口座、右に期間）、見出しの下は「戦略」の画面と同じ並び。スマホは 名前→口座→期間→頻度→条件→注文量・リスク上限→実行 の順 */}
			<div className="flex flex-col gap-3.5 lg:grid lg:grid-cols-2 lg:items-start">
				<div className="flex flex-col gap-3.5">
					<Card className="flex flex-col gap-3.5">
						<div className="flex flex-col gap-1.5">
							<label htmlFor={ids.name} className="text-[13px] font-semibold">
								バックテスト名
							</label>
							<input
								id={ids.name}
								value={draft.name}
								onChange={(e) => update({ name: e.target.value })}
								aria-invalid={nameError ? true : undefined}
								className="h-12 rounded-[10px] border border-line bg-surface px-3 text-[15px] font-semibold aria-invalid:border-2 aria-invalid:border-loss"
							/>
							{nameError && (
								<span className="text-xs font-semibold text-loss">
									{nameError}
								</span>
							)}
						</div>
					</Card>
					<Card className="flex flex-col gap-3.5">
						<h2 className="text-[15px] font-bold">口座</h2>
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
				</div>
				<Card className="flex flex-col gap-3.5">
					<div className="flex items-center gap-1.5">
						<h2 className="text-[15px] font-bold">期間</h2>
						<Help label="期間">
							<p>
								相場データは、月が替わると直近2か月の期間を値動きで「上昇相場」「下落相場」「レンジ相場」「乱高下相場」のどれかに分けて作る。同じ相場の別の時期で試すときに使う。
							</p>
							<p>{REGIME_RULE_TEXT}</p>
							<p>
								データセットは、相場データを束ねて名前を付けたもの。相場データごとに同じ条件でバックテストを1件ずつ実行し、成績を合算する。初期資金は相場データごとに戻す。実行できない相場データが1つでもあれば、組ごとに比べられなくなるので全体を実行しない。
							</p>
						</Help>
					</div>
					<Segmented
						name="period-mode"
						label="期間の決め方"
						options={PERIOD_MODES}
						value={draft.periodMode ?? "range"}
						onChange={(v) =>
							// 一番新しいものを選んだまま残す。後で新しい相場データができても、選んだ期間を変えない
							update({
								periodMode: v,
								segmentId: draft.segmentId ?? segments[0]?.id ?? null,
								datasetId: dataset?.id ?? datasets[0]?.id ?? null,
							})
						}
					/>
					{byDataset ? (
						<DatasetPicker
							datasets={datasets}
							segments={segments}
							selected={dataset}
							onSelect={(datasetId) => update({ datasetId })}
							onSaved={reloadDatasets}
						/>
					) : bySegment ? (
						segments.length > 0 && (
							<div className="flex flex-col gap-1">
								<label htmlFor={ids.segment} className="text-xs text-text-2">
									相場データ
								</label>
								<select
									id={ids.segment}
									value={segment?.id ?? ""}
									onChange={(e) =>
										e.target.value &&
										update({ segmentId: Number(e.target.value) })
									}
									className="h-11 rounded-[10px] border border-line bg-surface px-2 text-sm"
								>
									{!segment && <option value="">選ぶ</option>}
									{segments.map((d) => (
										<option key={d.id} value={d.id}>
											{segmentName(d)}
										</option>
									))}
								</select>
								{segment && (
									<span className="num text-xs text-text-2">
										{segmentSummary(segment)}
									</span>
								)}
							</div>
						)
					) : (
						<>
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
						</>
					)}
					{periodError && (
						<span className="text-xs font-semibold text-loss">
							{periodError}
						</span>
					)}
					{!byDataset && <CoverageBar cov={cov} from={fromMs} to={toMs} />}
					<div className="flex flex-col gap-1">
						<span className="text-[13px] font-semibold">足</span>
						<span className="num text-sm">
							{needed.length > 0
								? `条件 ${needed.map((t) => TIMEFRAME_LABELS[t]).join("・")} · `
								: ""}
							{byDataset
								? TIMEFRAME_LABELS[tf]
								: `${TIMEFRAME_LABELS[tf]} ${formatInt(bars)} 本`}
							{step ? ` · ${TIMEFRAME_LABELS[step.timeframe]}で判定` : ""}
							{usesJudgments && " · 市場評価の履歴を使う"}
						</span>
						{usesJudgments && !byDataset && firstScoredAt !== null && (
							<span className="num text-xs text-text-2">
								市場評価の記録の開始: {formatDateTime(firstScoredAt)}
								{judgmentError === null &&
									fromMs < firstScoredAt &&
									"（それより前はデータなし）"}
							</span>
						)}
						{usesJudgments &&
							!byDataset &&
							firstScoredAt === null &&
							judgmentError === null && (
								<span className="text-xs text-text-2">
									市場評価の記録がまだ無いため、全期間がデータなし
								</span>
							)}
					</div>
					{usesJudgments && (
						<div className="flex flex-col gap-1.5">
							<div className="flex items-center gap-1.5">
								<label
									htmlFor={ids.version}
									className="text-[13px] font-semibold"
								>
									採点の版
								</label>
								<Help label="採点の版">
									<p>
										市場評価に使うニュースの採点を、どの採点の基準の版のものにするか。「運用どおり」は記事ごとに運用で採点したときの版を使う。
									</p>
									<p>
										版を選ぶと、期間の記事をすべてその版で採点し直した結果で市場評価を出す。採点の基準の改善を確かめるときに使う。
									</p>
									<p>
										記事は、公開から取得の間隔（設定の「ニュース」）だけたった時刻から市場評価に使う。運用で取得と採点を待つ分を見込むため。
									</p>
								</Help>
							</div>
							<select
								id={ids.version}
								value={criteriaVersion ?? ""}
								onChange={(e) =>
									update({
										criteriaVersion:
											e.target.value === "" ? null : Number(e.target.value),
									})
								}
								className="h-11 rounded-[10px] border border-line bg-surface px-2 text-sm"
							>
								<option value="">運用どおり</option>
								{[...criteriaVersions].reverse().map((v) => (
									<option key={v.version} value={v.version}>
										v{v.version} {v.note}
									</option>
								))}
							</select>
							{criteriaVersion !== null && !byDataset && (
								<RescoreStatus
									from={fromMs}
									to={toMs}
									version={criteriaVersion}
									onChange={setRescore}
								/>
							)}
						</div>
					)}
					{step?.limited && <Note>{stepLimitedText(step.timeframe)}</Note>}
					{shortfalls.length > 0 && (
						<Note>
							{`期間より前の${shortfalls.map((x) => `${TIMEFRAME_LABELS[x.timeframe]}が ${formatInt(x.missing)} 本`).join("・")}足りないため、期間の初めはその足の条件を判定しない`}
						</Note>
					)}
					{judgmentError && (
						<span role="alert" className="text-xs font-semibold text-loss">
							{judgmentError}
						</span>
					)}
				</Card>
				<div className="mt-2 flex flex-col gap-0.5 lg:col-span-2">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
						<div className="flex shrink-0 items-center gap-1.5">
							<h2 className="text-[17px] font-bold">戦略設定</h2>
							<Help label="戦略設定">
								<p>
									読み込んだ条件をコピーして試す。ここで変えても戦略には保存されない。
								</p>
							</Help>
						</div>
						{/* スマホは見出しとボタンの下の行に出す。長い名前は省略し、「変更あり」は残す */}
						{draft.improvement && !template && (
							<span className="order-last flex min-w-0 basis-full text-xs text-text-2 lg:order-none lg:basis-auto">
								AI の改善版
							</span>
						)}
						{template && (
							<span className="order-last flex min-w-0 basis-full text-xs text-text-2 lg:order-none lg:basis-auto">
								<span className="truncate">{template.label}</span>
								{edited && <span className="shrink-0">（変更あり）</span>}
							</span>
						)}
						<Button
							size="sm"
							className="ml-auto shrink-0"
							onClick={() => setPicking(true)}
						>
							条件を読み込む
						</Button>
					</div>
					{draft.improvement && (
						<ImprovementChanges
							changes={draft.improvement.changes}
							onClose={() => update({ improvement: null })}
						/>
					)}
				</div>
				<div className="contents lg:flex lg:flex-col lg:gap-3.5">
					<FrequencyCard {...editor} />
					<div className="order-1 flex flex-col gap-3.5 lg:order-none">
						<RiskLimitCard {...editor} />
					</div>
				</div>
				<div className="contents lg:flex lg:flex-col lg:gap-3.5">
					<BuyRulesEditor {...editor} latestPrice={latest} />
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
					{runningDataset && (
						<Card className="flex flex-col gap-2.5">
							<div className="flex items-center justify-between">
								<strong>データセットでまとめて実行中</strong>
								<span className="num font-semibold">
									{Math.round(runningDataset.progress * 100)}%
								</span>
							</div>
							<ProgressBar
								value={runningDataset.progress * 100}
								label="まとめた実行の進み具合"
							/>
							<p className="text-xs text-text-2">
								{runningDataset.segmentIds.length}{" "}
								件の相場データを1件ずつ実行する。他の画面へ移っても処理は続く。終わると合算した結果へ移動する。
							</p>
							<Button size="sm" className="self-start" onClick={cancel}>
								実行を中止
							</Button>
						</Card>
					)}
					{lastDataset && (
						<Note>
							<div className="flex items-start gap-2">
								<span className="flex-1">
									{lastDataset.status === "canceled"
										? "まとめた実行を中止した"
										: `まとめた実行が失敗した: ${lastDataset.error ?? "原因不明"}`}
								</span>
								<Button variant="link" onClick={job.clearFinished}>
									閉じる
								</Button>
							</div>
						</Note>
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
					{problem?.kind === "blocked" && (
						<BlockedSegments
							blockers={problem.blockers}
							busy={busy}
							onSkipGaps={() => run(true)}
						/>
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
								busyRunning ||
								hasErr ||
								(!byDataset && bars === 0) ||
								judgmentError !== null ||
								rescoreBlocked
							}
							onClick={() => run(false)}
						>
							{busyRunning
								? "実行中…"
								: hasErr
									? "入力を直すと実行できる"
									: !byDataset && bars === 0
										? "期間にデータが無い"
										: rescoreBlocked
											? `v${criteriaVersion} の採点がそろうと実行できる`
											: byDataset && dataset
												? `${dataset.segments.length} 件をまとめて実行`
												: "バックテストを実行"}
						</Button>
					</div>
				</div>
			</div>
			{picking && (
				<TemplateDialog
					choices={choices}
					replacing={edited || template === null}
					onClose={() => setPicking(false)}
					onPick={(t) => {
						setPicking(false);
						// バックテスト名は変えない
						update({ template: t, params: t.params, improvement: null });
					}}
				/>
			)}
		</BacktestFrame>
	);
}

/** データセットで実行できない相場データと理由。欠損だけなら、承知で実行できる */
function BlockedSegments({
	blockers,
	busy,
	onSkipGaps,
}: {
	blockers: DatasetBlocker[];
	busy: boolean;
	onSkipGaps: () => void;
}) {
	const onlyGaps = blockers.every((b) => b.error.kind === "gaps");
	return (
		<div
			role="alert"
			className="flex flex-col gap-2 rounded-[10px] bg-warn px-3.5 py-3 text-xs"
		>
			<strong className="text-[13px]">
				実行できない相場データがあるため、全体を実行しなかった
			</strong>
			<ul className="flex list-disc flex-col gap-1 pl-4">
				{blockers.map((b) => (
					<li key={b.segment.id}>
						<span className="num font-semibold">{segmentName(b.segment)}</span>:{" "}
						{blockerText(b.error)}
					</li>
				))}
			</ul>
			{onlyGaps ? (
				<Button
					size="sm"
					className="self-start"
					disabled={busy}
					onClick={onSkipGaps}
				>
					欠損を飛ばして実行
				</Button>
			) : (
				<span>データセットを編集して外すか、条件を直してから実行する。</span>
			)}
		</div>
	);
}

function blockerText(e: DatasetBlocker["error"]): string {
	if (e.kind === "gaps") {
		return `データの欠損が ${e.gapCount} か所（合計 ${formatInt(e.missingBars)} 本）`;
	}
	if (e.kind === "invalid_params") return "条件に入力の誤りがある";
	if (e.kind === "busy") return "別のバックテストを実行中";
	return e.message;
}

/** テンプレートを選ぶモーダル。選ぶとその条件で今の条件を置き換える */
/** AI の改善版で変わった項目。見出しごとに、変える前の行と変えた後の行を出す */
function ImprovementChanges({
	changes,
	onClose,
}: {
	changes: ConditionSetChange[];
	onClose: () => void;
}) {
	return (
		<section
			aria-label="AI の改善版の変更点"
			className="mt-1.5 flex flex-col gap-2 rounded-[10px] border border-line bg-surface px-3.5 py-3 text-xs"
		>
			<div className="flex items-center justify-between gap-2">
				<h3 className="font-bold">AI の改善版で変えた項目（元の実行から）</h3>
				<Button size="sm" onClick={onClose}>
					閉じる
				</Button>
			</div>
			{changes.map((c) => {
				// 片方だけなら条件の削除か追加。両方あれば値を変えた
				const both = c.removed.length > 0 && c.added.length > 0;
				return (
					<div key={c.section} className="flex flex-col gap-0.5">
						<span className="font-semibold">{c.section}</span>
						{c.removed.length > 0 && (
							<span className="whitespace-pre-line text-text-2">
								{c.removed
									.map((l) => `${both ? "変更前" : "削除"}: ${l}`)
									.join("\n")}
							</span>
						)}
						{c.added.length > 0 && (
							<span className="whitespace-pre-line">
								{c.added
									.map((l) => `${both ? "変更後" : "追加"}: ${l}`)
									.join("\n")}
							</span>
						)}
					</div>
				);
			})}
		</section>
	);
}

function TemplateDialog({
	choices,
	replacing,
	onClose,
	onPick,
}: {
	choices: Template[];
	replacing: boolean;
	onClose: () => void;
	onPick: (t: Template) => void;
}) {
	const groups = [
		["ひな形", choices.filter((t) => t.key.startsWith("t:"))],
		["保存済みの戦略", choices.filter((t) => t.key.startsWith("s:"))],
	] as const;
	return (
		<Modal title="条件を読み込む" onClose={onClose}>
			{replacing && <Note>今の条件は、選んだ条件に置き換わる。</Note>}
			{groups.map(
				([label, items]) =>
					items.length > 0 && (
						<div key={label} className="flex shrink-0 flex-col gap-1.5">
							<span className="text-xs text-text-2">{label}</span>
							<div className="overflow-hidden rounded-xl border border-line">
								{items.map((t) => (
									<button
										key={t.key}
										type="button"
										onClick={() => onPick(t)}
										className="flex w-full flex-col gap-0.5 border-b border-line px-4 py-3 text-left last:border-b-0 hover:bg-surface-2"
									>
										<strong className="text-sm">{t.label}</strong>
										{t.description && (
											<span className="text-xs text-text-2">
												{t.description}
											</span>
										)}
									</button>
								))}
							</div>
						</div>
					),
			)}
			{/* 項目が多くてもモーダルの中で縮めず、スクロールさせる */}
			<Button className="shrink-0" onClick={onClose}>
				やめる
			</Button>
		</Modal>
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
		return <p className="text-xs text-text-2">この粒度のデータがまだ無い。</p>;
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
			<ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-2">
				<LegendItem swatch="bg-accent opacity-80">選んだ期間</LegendItem>
				<LegendItem swatch="bg-line">取り込み済み</LegendItem>
				{cov.gaps.length > 0 && (
					<LegendItem swatch="bg-warn-strong">欠損（足が無い）</LegendItem>
				)}
			</ul>
		</div>
	);
}

function LegendItem({
	swatch,
	children,
}: {
	swatch: string;
	children: ReactNode;
}) {
	return (
		<li className="flex items-center gap-1">
			<span aria-hidden="true" className={`size-2.5 rounded-sm ${swatch}`} />
			{children}
		</li>
	);
}

function BacktestFrame({
	tab,
	children,
}: {
	tab: BacktestTab;
	children: ReactNode;
}) {
	const [, setSearch] = useSearchParams();
	return (
		<Page
			title="バックテスト"
			help={
				<p>
					ひな形か保存済みの戦略から条件を作って、取り込んだ CSV
					の過去データで模擬売買する。
				</p>
			}
		>
			<Tabs
				label="バックテストの画面"
				items={TABS}
				current={tab}
				onSelect={(t) =>
					setSearch(t === "run" ? {} : { tab: t }, { replace: true })
				}
			/>
			{children}
		</Page>
	);
}

/** 開始は日付単位なので、記録が日の途中から始まっていればその翌日が最初に選べる日 */
function firstAllowedFrom(firstScoredAt: number): number {
	const day = fromDateInputValue(toDateInputValue(firstScoredAt)) ?? 0;
	return day === firstScoredAt ? day : day + DAY;
}
