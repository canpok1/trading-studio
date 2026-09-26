import type { BacktestRun, TimeframeCoverage } from "@trading-studio/backend";
import type { Timeframe } from "@trading-studio/core";
import { TIMEFRAME_LABELS, TIMEFRAMES } from "@trading-studio/core";
import { useCallback, useId, useState } from "react";
import { useApi } from "../api";
import { Page } from "../components/Page";
import { ErrorState, LoadingCard } from "../components/States";
import { Button, Card, Segmented } from "../components/ui";
import {
	formatDate,
	formatDateTime,
	fromDateInputValue,
	toDateInputValue,
} from "../format";
import { saveResponse } from "../lib/download";
import { formatSignedPercent } from "../lib/number";
import { errorMessage, readJson, useAsync } from "../lib/useAsync";

const DAY = 24 * 60 * 60 * 1000;
/** 分析用の既定の期間（日数） */
const ANALYSIS_DAYS = 30;

const TF_OPTIONS = TIMEFRAMES.map(
	(t) => [t, TIMEFRAME_LABELS[t].replace("足", "")] as const,
);

export function ExportPage() {
	return (
		<Page
			title="エクスポート"
			description="記録をファイルで書き出す。分析を Claude に頼むときや、バックアップに使う"
		>
			<section aria-label="分析用（ZIP）" className="flex flex-col gap-2">
				<h2 className="text-[15px] font-bold">分析用（ZIP）</h2>
				<AnalysisCard />
			</section>
			<section aria-label="価格データ（CSV）" className="flex flex-col gap-2">
				<h2 className="text-[15px] font-bold">価格データ（CSV）</h2>
				<CandleCsvSection />
			</section>
		</Page>
	);
}

/** JST の日付の範囲。to は終わりの日（その日を含む） */
type Period = { from: string; to: string };

function periodRange({ from, to }: Period) {
	const fromMs = fromDateInputValue(from);
	const toMs = fromDateInputValue(to);
	const error =
		fromMs === null || toMs === null
			? "開始日と終了日を入れる"
			: fromMs > toMs
				? "終了日は開始日より後にする"
				: null;
	// 期間は [開始日の 0:00, 終了日の翌日の 0:00)
	return error === null
		? { error, from: fromMs as number, to: (toMs as number) + DAY }
		: { error, from: null, to: null };
}

function PeriodInputs({
	value,
	onChange,
	disabled,
}: {
	value: Period;
	onChange: (p: Period) => void;
	disabled: boolean;
}) {
	const ids = { from: useId(), to: useId() };
	return (
		<div className="grid grid-cols-[minmax(0,1fr)_20px_minmax(0,1fr)] items-end gap-1.5">
			<div className="flex flex-col gap-1">
				<label htmlFor={ids.from} className="text-xs text-text-2">
					開始
				</label>
				<input
					id={ids.from}
					type="date"
					value={value.from}
					onChange={(e) => onChange({ ...value, from: e.target.value })}
					disabled={disabled}
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
					value={value.to}
					onChange={(e) => onChange({ ...value, to: e.target.value })}
					disabled={disabled}
					className="num h-11 min-w-0 rounded-[10px] border border-line bg-surface px-2 text-sm"
				/>
			</div>
		</div>
	);
}

function Alert({ children }: { children: string | null }) {
	if (!children) return null;
	return (
		<p role="alert" className="text-xs font-semibold text-loss">
			{children}
		</p>
	);
}

/** 分析用の ZIP。期間と、期間内に実行したバックテストから選んだものを入れる */
function AnalysisCard() {
	const api = useApi();
	const [period, setPeriod] = useState<Period>(() => {
		const today = Date.now();
		return {
			from: toDateInputValue(today - (ANALYSIS_DAYS - 1) * DAY),
			to: toDateInputValue(today),
		};
	});
	const range = periodRange(period);
	const [selected, setSelected] = useState<Set<number>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (range.from === null || range.to === null) return null;
		const res = await api.api.export.backtests.$get({
			query: { from: String(range.from), to: String(range.to) },
		});
		return (await readJson<{ runs: BacktestRun[] }>(res)).runs;
	}, [api, range.from, range.to]);
	const { state } = useAsync(load);
	const runs = state.kind === "ok" ? (state.data ?? []) : [];
	// 期間を変えて一覧から外れた実行は入れない
	const chosen = runs.filter((r) => selected.has(r.id)).map((r) => r.id);

	const toggle = (id: number, on: boolean) =>
		setSelected((cur) => {
			const next = new Set(cur);
			if (on) next.add(id);
			else next.delete(id);
			return next;
		});

	const run = async () => {
		if (range.from === null || range.to === null) return;
		setBusy(true);
		setError(null);
		try {
			const res = await api.api.export.analysis.$get({
				query: {
					from: String(range.from),
					to: String(range.to),
					backtests: chosen.join(","),
				},
			});
			if (!res.ok) await readJson(res);
			await saveResponse(res, "trading-studio-analysis.zip");
		} catch (e) {
			setError(`書き出せなかった: ${errorMessage(e)}`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card className="flex flex-col gap-3">
			<PeriodInputs value={period} onChange={setPeriod} disabled={busy} />
			<Alert>{range.error}</Alert>
			<fieldset className="flex min-w-0 flex-col gap-1.5">
				<legend className="mb-1 text-xs text-text-2">
					入れるバックテスト（期間内に実行して完了したもの）
				</legend>
				{state.kind === "loading" && <LoadingCard lines={1} />}
				{state.kind === "error" && (
					<ErrorState
						what="バックテストの一覧を読み込めなかった"
						next="サーバーが動いているか確かめてから、期間を選び直す"
					/>
				)}
				{state.kind === "ok" && runs.length === 0 && (
					<p className="text-xs text-text-2">期間内に実行したものは無い</p>
				)}
				{runs.map((r) => {
					const pct = r.summary?.pnlPercent;
					return (
						<label
							key={r.id}
							className="flex cursor-pointer items-center gap-3 rounded-[10px] border border-line px-3 py-2 has-checked:border-accent"
						>
							<input
								type="checkbox"
								checked={selected.has(r.id)}
								onChange={(e) => toggle(r.id, e.target.checked)}
								disabled={busy}
								className="size-4 shrink-0 accent-accent"
							/>
							<span className="flex min-w-0 flex-1 flex-col gap-0.5">
								<strong className="truncate text-sm">
									{r.strategyName} · {TIMEFRAME_LABELS[r.timeframe]}
								</strong>
								<span className="num text-xs text-text-2">
									{formatDate(r.from)}〜{formatDate(r.to - 1)} ·{" "}
									{formatDateTime(r.startedAt)} 実行
								</span>
							</span>
							{pct !== undefined && (
								<span
									className={`num text-sm font-semibold ${pct >= 0 ? "text-profit" : "text-loss"}`}
								>
									{formatSignedPercent(pct)}
								</span>
							)}
						</label>
					);
				})}
			</fieldset>
			<Alert>{error}</Alert>
			<Button
				variant="primary"
				onClick={run}
				disabled={busy || range.error !== null}
			>
				{busy ? "書き出し中…" : "分析用 ZIP を書き出す"}
			</Button>
			<p className="text-xs leading-relaxed text-text-2">
				ニュースと AI
				の採点、採点の基準、集計ルール、1時間ごとの判定、1分足、戦略、ペーパーの判断と注文、選んだバックテストの中身を、表ごとの
				CSV にして入れる。列の意味と単位は ZIP の中の README.md
				に書いてある。API キーは入れない。
			</p>
		</Card>
	);
}

function CandleCsvSection() {
	const api = useApi();
	const load = useCallback(
		() =>
			api.api.data.coverage
				.$get()
				.then((r) => readJson<{ timeframes: TimeframeCoverage[] }>(r)),
		[api],
	);
	const { state, reload } = useAsync(load);
	if (state.kind === "loading") return <LoadingCard lines={2} />;
	if (state.kind === "error") {
		return (
			<Card>
				<ErrorState
					what="保存済みの足を読み込めなかった"
					next="サーバーが動いているか確かめてから、もう一度読み込む"
					action={
						<Button size="sm" onClick={reload}>
							再読み込み
						</Button>
					}
				/>
			</Card>
		);
	}
	const coverage = state.data.timeframes;
	if (!coverage.some((c) => c.count > 0)) {
		return (
			<Card>
				<p className="text-xs text-text-2">
					保存済みの足が無い。過去データの画面で CSV
					を取り込むか、収集した足が溜まると書き出せる。
				</p>
			</Card>
		);
	}
	return <CandleCsvCard coverage={coverage} />;
}

/** 保存済みの足を CSV で書き出す。書き出した CSV はそのまま取り込み直せる */
function CandleCsvCard({ coverage }: { coverage: TimeframeCoverage[] }) {
	const api = useApi();
	const withData = coverage.filter((c) => c.count > 0);
	const [timeframe, setTimeframe] = useState<Timeframe>(
		withData.some((c) => c.timeframe === "1m")
			? "1m"
			: (withData[0]?.timeframe ?? "1m"),
	);
	// 未指定なら、選んだ粒度の保存済みの全期間
	const [period, setPeriod] = useState<Period | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const cov = withData.find((c) => c.timeframe === timeframe);
	const value = period ?? {
		from: toDateInputValue((cov?.firstTime as number) ?? Date.now()),
		to: toDateInputValue((cov?.lastTime as number) ?? Date.now()),
	};
	const range = periodRange(value);

	const run = async () => {
		if (range.from === null || range.to === null) return;
		setBusy(true);
		setError(null);
		try {
			const res = await api.api.data.export.$get({
				query: { timeframe, from: String(range.from), to: String(range.to) },
			});
			if (!res.ok) await readJson(res);
			await saveResponse(res, "btcjpy.csv");
		} catch (e) {
			setError(`書き出せなかった: ${errorMessage(e)}`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card className="flex flex-col gap-3">
			<Segmented
				name="export-timeframe"
				label="書き出す足の粒度"
				options={TF_OPTIONS.filter(([t]) =>
					withData.some((c) => c.timeframe === t),
				)}
				value={timeframe}
				onChange={(t) => {
					setTimeframe(t);
					setPeriod(null);
				}}
				disabled={busy}
				size="sm"
			/>
			<PeriodInputs value={value} onChange={setPeriod} disabled={busy} />
			<Alert>{range.error}</Alert>
			<Alert>{error}</Alert>
			<Button
				variant="primary"
				onClick={run}
				disabled={busy || range.error !== null}
			>
				{busy
					? "書き出し中…"
					: `${TIMEFRAME_LABELS[timeframe]}を CSV で書き出す`}
			</Button>
			<p className="text-xs leading-relaxed text-text-2">
				取り込みと同じ列（日時は
				JST）で書き出すので、そのまま取り込み直せる。欠損は埋めない。1分足を残せば、粗い粒度は取り込み直したときに作り直される。
			</p>
		</Card>
	);
}
