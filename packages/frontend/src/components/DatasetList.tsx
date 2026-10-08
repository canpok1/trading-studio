import type { Dataset } from "@trading-studio/backend";
import type { MarketRegime } from "@trading-studio/core";
import { MARKET_REGIME_LABELS, MARKET_REGIMES } from "@trading-studio/core";
import { useCallback, useState } from "react";
import { useApi } from "../api";
import { formatDate } from "../format";
import { datasetMonths, signedPercent } from "../lib/dataset";
import { readJson, useAsync } from "../lib/useAsync";
import { Help } from "./Help";
import { EmptyState, ErrorState, LoadingCard } from "./States";
import { Button, Card, Segmented } from "./ui";

type Filter = "all" | MarketRegime;

const FILTERS: readonly (readonly [Filter, string])[] = [
	["all", "すべて"],
	...MARKET_REGIMES.map(
		(r) => [r, MARKET_REGIME_LABELS[r].replace("相場", "")] as const,
	),
];

/** インポート画面のデータセットの一覧。相場で絞れる */
export function DatasetList() {
	const api = useApi();
	const [filter, setFilter] = useState<Filter>("all");
	const load = useCallback(
		() =>
			api.api.datasets
				.$get({ query: filter === "all" ? {} : { regime: filter } })
				.then((res) => readJson<{ datasets: Dataset[] }>(res)),
		[api, filter],
	);
	const { state, reload } = useAsync(load);
	return (
		<section aria-label="データセット" className="flex flex-col gap-2.5">
			<div className="flex items-center gap-1.5">
				<h2 className="text-[15px] font-bold">データセット</h2>
				<Help label="データセット">
					<p>
						毎月1日に、直近2か月の期間を値動きで相場に分けて作る。足は写さず期間だけを持ち、バックテストの「期間」でデータセットを選ぶとその期間で実行する。
					</p>
					<p>
						1分足が期間の95%以上そろっている期間だけ作る。後から取り込んだ過去の足からも、次の
						4:00 に作る。
					</p>
					<p>
						乱高下は日ごとの値動き（終値の変化）のばらつきが3.5%以上。それ以外は期間の騰落率が+12%以上で上昇、−12%以下で下落、その間はレンジ。
					</p>
				</Help>
			</div>
			<Segmented
				name="dataset-regime"
				label="相場で絞る"
				options={FILTERS}
				value={filter}
				onChange={setFilter}
				size="sm"
			/>
			{state.kind === "loading" && <LoadingCard lines={2} />}
			{state.kind === "error" && (
				<Card>
					<ErrorState
						what="データセットを読み込めなかった"
						next="サーバーが動いているか確かめてから、もう一度読み込む"
						action={
							<Button size="sm" onClick={reload}>
								もう一度読み込む
							</Button>
						}
					/>
				</Card>
			)}
			{state.kind === "ok" &&
				(state.data.datasets.length === 0 ? (
					<Card>
						<EmptyState
							title={
								filter === "all"
									? "データセットはまだ無い"
									: `${MARKET_REGIME_LABELS[filter]}のデータセットは無い`
							}
							description="1分足が2か月そろうと、次の月の1日に作る"
						/>
					</Card>
				) : (
					<ul className="overflow-hidden rounded-xl border border-line bg-surface">
						{state.data.datasets.map((d) => (
							<li
								key={d.id}
								className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-3 last:border-b-0"
							>
								<span className="flex min-w-0 flex-col gap-0.5">
									<span className="num font-semibold">{datasetMonths(d)}</span>
									<span className="num text-xs text-text-2">
										{formatDate(d.from)}〜{formatDate(d.to - 1)} · 騰落率{" "}
										{signedPercent(d.returnPpm)} · 日ごとの値動き{" "}
										{(d.volatilityPpm / 10_000).toFixed(1)}%
									</span>
								</span>
								<span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-semibold">
									{MARKET_REGIME_LABELS[d.regime]}
								</span>
							</li>
						))}
					</ul>
				))}
		</section>
	);
}
