import type { RunListResult, RunSort } from "@trading-studio/backend";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useApi } from "../../api";
import { formatDate, formatDateTime } from "../../format";
import type { RunFilterState } from "../../lib/backtest-history";
import {
	parseRunFilter,
	RUN_SORT_LABELS,
	runFilterParams,
	runQuery,
} from "../../lib/backtest-history";
import { useBacktestJob } from "../../lib/backtest-job";
import { formatSignedPercent } from "../../lib/number";
import { errorMessage, readJson } from "../../lib/useAsync";
import { SearchIcon } from "../icons";
import { ErrorState, Skeleton } from "../States";
import { Button } from "../ui";

/** 最初に出す件数と、「さらに表示」で足す件数 */
const RUNS_PAGE = 20;
/** キーワードを打ち終えてから問い合わせるまでの待ち */
const TYPING_MS = 400;

const SORTS = Object.keys(RUN_SORT_LABELS) as RunSort[];

/** 過去の実行の一覧。条件は URL に持ち、絞り込みと件数はサーバーで行う */
export function RunHistory() {
	const api = useApi();
	const job = useBacktestJob();
	const [params, setParams] = useSearchParams();
	const filterKey = runFilterParams(parseRunFilter(params)).toString();
	const filter = parseRunFilter(new URLSearchParams(filterKey));
	const onChange = useCallback(
		(f: RunFilterState) => setParams(runFilterParams(f), { replace: true }),
		[setParams],
	);
	const [limit, setLimit] = useState(RUNS_PAGE);
	// 条件を変えたら読む件数を戻す
	// biome-ignore lint/correctness/useExhaustiveDependencies: filterKey が変わったときだけ戻す
	useEffect(() => setLimit(RUNS_PAGE), [filterKey]);

	// 「さらに表示」や条件の変更で読み直す間も、届くまでは今の一覧を出したままにする（一覧が縮んで位置がずれないように）
	const [data, setData] = useState<RunListResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const seq = useRef(0);
	const load = useCallback(async () => {
		const id = ++seq.current;
		const f = parseRunFilter(new URLSearchParams(filterKey));
		try {
			const r = await api.api.backtests
				.$get({ query: runQuery(f, limit) })
				.then((res) => readJson<RunListResult>(res));
			if (id !== seq.current) return;
			setData(r);
			setError(null);
		} catch (e) {
			if (id === seq.current) setError(errorMessage(e));
		}
	}, [api, filterKey, limit]);
	useEffect(() => {
		load();
	}, [load]);

	// 実行が終わったら読み直す
	const runningId = job.running?.id ?? null;
	const prevRunning = useRef(runningId);
	useEffect(() => {
		if (prevRunning.current !== null && runningId === null) load();
		prevRunning.current = runningId;
	}, [runningId, load]);

	const filtered = filter.q.trim() !== "" || filter.hideFailed;
	return (
		<section aria-label="過去の実行" className="flex flex-col gap-2.5">
			<FilterBar filter={filter} onChange={onChange} />
			<div className="flex items-center justify-between gap-2">
				<label className="flex cursor-pointer items-center gap-2 text-sm">
					<input
						type="checkbox"
						className="h-4 w-4 accent-accent"
						checked={filter.hideFailed}
						onChange={(e) =>
							onChange({ ...filter, hideFailed: e.target.checked })
						}
					/>
					失敗・中止を隠す
				</label>
				{data && (
					<span className="num text-xs text-text-2">{data.total} 件</span>
				)}
			</div>
			{!data && error && (
				<ErrorState
					what="過去の実行を読み込めなかった"
					next={error}
					action={<Button onClick={load}>もう一度読み込む</Button>}
				/>
			)}
			{!data && !error && (
				<div role="status" aria-label="読み込み中">
					<Skeleton className="h-[240px] w-full" />
				</div>
			)}
			{data && (
				<div className="overflow-hidden rounded-xl border border-line bg-surface">
					{data.runs.length === 0 && (
						<p className="px-4 py-3.5 text-xs text-text-2">
							{filtered
								? "条件に合う実行が無い。"
								: "まだ実行していない。「実行」のタブで条件を選んで実行すると、ここに並ぶ。"}
						</p>
					)}
					{data.runs.map((r) => {
						const pct = r.summary?.pnlPercent;
						return (
							<Link
								key={r.id}
								to={`/backtest/runs/${r.id}`}
								className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 hover:bg-surface-2"
							>
								<span className="flex min-w-0 flex-1 flex-col gap-0.5">
									<strong className="truncate text-sm">{r.name}</strong>
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
			)}
			{data && error && (
				<p role="alert" className="text-xs font-semibold text-loss">
					読み込めなかった: {error}
				</p>
			)}
			{data && data.total > data.runs.length && (
				<Button onClick={() => setLimit((n) => n + RUNS_PAGE)}>
					さらに表示（あと {data.total - data.runs.length} 件）
				</Button>
			)}
		</section>
	);
}

function FilterBar({
	filter,
	onChange,
}: {
	filter: RunFilterState;
	onChange: (f: RunFilterState) => void;
}) {
	const [q, setQ] = useState(filter.q);
	// 自分で書いたキーワード。URL がこれ以外に変わったとき（戻る など）だけ欄を合わせ、打っている途中の文字を消さない
	const written = useRef(filter.q);
	useEffect(() => {
		if (filter.q !== written.current) {
			written.current = filter.q;
			setQ(filter.q);
		}
	}, [filter.q]);
	useEffect(() => {
		// 空白だけのキーワードは URL に書かないので、前後の空白を除いて比べる
		if (q.trim() === filter.q.trim()) return;
		const id = setTimeout(() => {
			written.current = q;
			onChange({ ...filter, q });
		}, TYPING_MS);
		return () => clearTimeout(id);
	}, [q, filter, onChange]);
	return (
		<div className="flex gap-2">
			<label className="flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-[10px] border border-line bg-surface px-2.5 text-text-2 focus-within:outline-2 focus-within:outline-accent">
				<SearchIcon />
				<input
					type="search"
					aria-label="名前で探す"
					placeholder="名前で探す"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none"
				/>
			</label>
			<select
				aria-label="並び順"
				value={filter.sort}
				onChange={(e) =>
					onChange({ ...filter, sort: e.target.value as RunSort })
				}
				className="h-9 shrink-0 rounded-[10px] border border-line bg-surface px-2 text-sm"
			>
				{SORTS.map((s) => (
					<option key={s} value={s}>
						{RUN_SORT_LABELS[s]}
					</option>
				))}
			</select>
		</div>
	);
}
