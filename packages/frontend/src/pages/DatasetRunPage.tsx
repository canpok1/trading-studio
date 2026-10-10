import type { DatasetRunDetail } from "@trading-studio/backend";
import type { DatasetSummary } from "@trading-studio/core";
import { MARKET_REGIME_LABELS } from "@trading-studio/core";
import { useCallback, useEffect, useRef } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useApi } from "../api";
import { Stat } from "../components/backtest/OrderViews";
import { FewTradesNote, GradeBadge, GradeHelp } from "../components/Grade";
import { Page } from "../components/Page";
import { ErrorState, LoadingCard } from "../components/States";
import { Button, Card, ProgressBar } from "../components/ui";
import { formatDateTime } from "../format";
import { useBacktestJob } from "../lib/backtest-job";
import {
	gradeMaxDrawdown,
	gradePnl,
	gradeProfitFactor,
	gradeWinRate,
} from "../lib/grade";
import { formatInt, formatSignedPercent } from "../lib/number";
import { segmentName } from "../lib/segment";
import { readJson, useAsync } from "../lib/useAsync";
import { RunHeader } from "./BacktestResultPage";
import type { BacktestDraft } from "./BacktestRunPage";

const BACK = { to: "/backtest?tab=history", label: "履歴" };
const TITLE = "バックテスト結果";

/** データセットでまとめて実行した結果。合算した成績と、相場データごとの成績 */
export function DatasetRunPage() {
	const api = useApi();
	const { id = "" } = useParams();
	const job = useBacktestJob();
	const load = useCallback(
		() =>
			api.api["dataset-runs"][":id"]
				.$get({ param: { id } })
				.then((r) => readJson<{ run: DatasetRunDetail }>(r)),
		[api, id],
	);
	const { state, reload } = useAsync(load);

	// この実行が終わったら読み直す
	const runningHere = job.runningDataset?.id === Number(id);
	const wasRunning = useRef(runningHere);
	useEffect(() => {
		if (wasRunning.current && !runningHere) reload();
		wasRunning.current = runningHere;
	}, [runningHere, reload]);

	// 別の画面や MCP で始めた実行も、開いたら追って進み具合を出す
	const untracked =
		state.kind === "ok" &&
		state.data.run.status === "running" &&
		job.runningDataset === null
			? state.data.run
			: null;
	useEffect(() => {
		if (untracked) job.trackDataset(untracked);
	}, [untracked, job.trackDataset]);

	if (state.kind === "loading") {
		return (
			<Page title={TITLE} back={BACK}>
				<LoadingCard />
			</Page>
		);
	}
	if (state.kind === "error") {
		return (
			<Page title={TITLE} back={BACK}>
				<Card>
					<ErrorState
						what={`結果を読み込めなかった（${state.message}）`}
						next="サーバーが動いているか確かめてから、もう一度読み込む"
						action={<Button onClick={reload}>もう一度読み込む</Button>}
					/>
				</Card>
			</Page>
		);
	}
	const { run } = state.data;
	const first = run.runs[0];
	const progress = runningHere
		? (job.runningDataset?.progress ?? 0)
		: run.progress;
	return (
		<Page title={TITLE} back={BACK} actions={<RerunButton run={run} />}>
			<div className="flex flex-col gap-3.5 lg:grid lg:grid-cols-2">
				{first ? (
					<RunHeader
						run={{ ...first, name: run.name }}
						subtitle={
							<span className="num text-xs text-text-2">
								データセット {run.datasetName}（{run.segmentIds.length} 件） ·
								初期資金 {formatInt(run.initialCash)}
								円（相場データごと）
								{run.skipGaps ? " · 欠損を飛ばして実行" : ""} ·{" "}
								{formatDateTime(run.startedAt)} 実行
							</span>
						}
					/>
				) : (
					<Card>
						<strong>{run.name}</strong>
					</Card>
				)}
				{run.status === "running" && (
					<Card className="flex flex-col gap-2.5">
						<strong>まとめて実行中</strong>
						<ProgressBar
							value={progress * 100}
							label="まとめた実行の進み具合"
						/>
					</Card>
				)}
				{(run.status === "failed" || run.status === "canceled") && (
					<Card>
						<ErrorState
							what={
								run.status === "canceled"
									? "この実行は中止した"
									: `この実行は失敗した（${run.error ?? "原因不明"}）`
							}
							next="条件を見直して、もう一度実行する"
							action={<RerunButton run={run} />}
						/>
					</Card>
				)}
				{run.status === "done" && run.summary && (
					<SummaryCard s={run.summary} />
				)}
				<div className="flex flex-col gap-3.5 lg:col-span-2">
					{run.summary && run.summary.byRegime.length > 0 && (
						<RegimeTable s={run.summary} />
					)}
					<SegmentTable run={run} />
				</div>
			</div>
		</Page>
	);
}

function rerunState(run: DatasetRunDetail): Partial<BacktestDraft> {
	return {
		name: run.name,
		template: null,
		params: run.params,
		initialCash: run.initialCash,
		fees: run.fees,
		criteriaVersion: run.criteriaVersion,
		periodMode: "dataset",
		datasetId: run.datasetId,
	};
}

function RerunButton({ run }: { run: DatasetRunDetail }) {
	const navigate = useNavigate();
	return (
		<Button
			size="sm"
			onClick={() => navigate("/backtest", { state: rerunState(run) })}
		>
			条件を変えて再実行
		</Button>
	);
}

const tone = (n: number) => (n >= 0 ? "text-profit" : "text-loss");

function SummaryCard({ s }: { s: DatasetSummary }) {
	return (
		<section
			aria-label="合算した成績"
			className="flex flex-col gap-3.5 rounded-xl border border-line bg-surface px-4 py-3.5"
		>
			<div className="flex items-center gap-1.5">
				<h2 className="text-[15px] font-bold">合算した成績</h2>
				<GradeHelp>
					<p>
						勝率・PF・取引回数は、すべての相場データの取引をまとめて数える。損益は相場データごとの損益率の平均と、いちばん悪かったもの。期間が重なる相場データがあると二重に数えるので、足し合わせない。
					</p>
					<p>
						最大DDは相場データごとの最大DDのうち最も大きいもの。損益の評価は、平均の損益率をガチホの平均と比べる。
					</p>
				</GradeHelp>
			</div>
			<div className="flex flex-col gap-0.5">
				<span className="flex items-center gap-1.5 text-xs text-text-2">
					損益の平均
					<GradeBadge
						value={gradePnl(
							s.averagePnlPercent,
							s.averageBuyHoldPercent,
							s.idle,
						)}
					/>
				</span>
				<span
					className={`num text-[30px] font-semibold tracking-tight ${tone(s.averagePnlPercent)}`}
				>
					{formatSignedPercent(s.averagePnlPercent)}
				</span>
				{s.averageBuyHoldPercent !== null && (
					<span className="num text-xs text-text-2">
						ガチホなら平均 {formatSignedPercent(s.averageBuyHoldPercent)}
					</span>
				)}
			</div>
			<div className="grid grid-cols-3 gap-x-2 gap-y-3 border-t border-line pt-3">
				<Stat
					label="最悪の損益"
					value={formatSignedPercent(s.worstPnlPercent)}
					tone={tone(s.worstPnlPercent)}
				/>
				<Stat label="ガチホ以上" value={`${s.beatBuyHold} / ${s.count} 件`} />
				<Stat label="取引回数" value={`${s.trades} 回`} />
				<Stat
					label="勝率"
					value={s.winRate !== null ? `${s.winRate.toFixed(1)}%` : "—"}
					sub={`${s.wins}勝 ${s.losses}敗`}
					grade={gradeWinRate(s.winRate)}
				/>
				<Stat
					label="PF"
					value={
						s.trades === 0
							? "—"
							: s.profitFactor === null
								? "∞"
								: s.profitFactor.toFixed(2)
					}
					grade={gradeProfitFactor(s.profitFactor, s.trades)}
				/>
				<Stat
					label="最大DD"
					value={
						s.maxDrawdownPercent > 0
							? `-${s.maxDrawdownPercent.toFixed(1)}%`
							: "0.0%"
					}
					tone={s.maxDrawdownPercent > 0 ? "text-loss" : ""}
					grade={gradeMaxDrawdown(s.maxDrawdownPercent)}
				/>
			</div>
			<FewTradesNote trades={s.trades} />
		</section>
	);
}

function RegimeTable({ s }: { s: DatasetSummary }) {
	return (
		<section
			aria-label="相場ごとの成績"
			className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-4 py-3.5"
		>
			<h2 className="text-[15px] font-bold">相場ごと</h2>
			<table className="w-full text-sm">
				<thead>
					<tr className="text-left text-xs text-text-2">
						<th className="py-1 font-normal">相場</th>
						<th className="py-1 text-right font-normal">件数</th>
						<th className="py-1 text-right font-normal">損益の平均</th>
					</tr>
				</thead>
				<tbody>
					{s.byRegime.map((r) => (
						<tr key={r.regime} className="border-t border-line">
							<td className="py-1.5">{MARKET_REGIME_LABELS[r.regime]}</td>
							<td className="num py-1.5 text-right">{r.count} 件</td>
							<td
								className={`num py-1.5 text-right font-semibold ${tone(r.averagePnlPercent)}`}
							>
								{formatSignedPercent(r.averagePnlPercent)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}

const STATUS_TEXT = {
	running: "実行中",
	failed: "失敗",
	canceled: "中止",
	done: "",
};

/** 相場データごとの成績。行から各バックテストの結果へ移る */
function SegmentTable({ run }: { run: DatasetRunDetail }) {
	return (
		<section
			aria-label="相場データごとの成績"
			className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-4 py-3.5"
		>
			<h2 className="text-[15px] font-bold">相場データごと</h2>
			{run.runs.length === 0 && (
				<p className="text-xs text-text-2">まだ実行した相場データが無い。</p>
			)}
			<ul className="flex flex-col">
				{run.runs.map((r) => {
					const s = r.summary;
					return (
						<li key={r.id} className="border-t border-line first:border-t-0">
							<Link
								to={`/backtest/runs/${r.id}`}
								className="flex items-center gap-3 py-2.5 hover:bg-surface-2"
							>
								<span className="flex min-w-0 flex-1 flex-col gap-0.5">
									<strong className="num text-sm">
										{r.segment
											? segmentName({ ...r, regime: r.segment.regime })
											: "相場データ"}
									</strong>
									{s && (
										<span className="num text-xs text-text-2">
											{s.buyHoldPercent !== undefined &&
												`ガチホ ${formatSignedPercent(s.buyHoldPercent)} · `}
											PF{" "}
											{s.trades === 0
												? "—"
												: s.profitFactor === null
													? "∞"
													: s.profitFactor.toFixed(2)}{" "}
											· 最大DD -{s.maxDrawdownPercent.toFixed(1)}% · 取引{" "}
											{s.trades} 回
										</span>
									)}
								</span>
								{r.status === "done" && s ? (
									<span
										className={`num text-sm font-semibold ${tone(s.pnlPercent)}`}
									>
										{formatSignedPercent(s.pnlPercent)}
									</span>
								) : (
									<span className="text-xs text-text-2">
										{STATUS_TEXT[r.status]}
									</span>
								)}
							</Link>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
