// 市場評価の記事ごとの精度。ニュース画面の各記事に出す（docs/news-page.md）

import type {
	AccuracyHorizon,
	ArticleAccuracy,
	ArticleAccuracyReport,
	NewsItem,
} from "@trading-studio/backend";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../api";
import { readJson, useInterval } from "../../lib/useAsync";

export const HORIZON_LABELS: Record<AccuracyHorizon, string> = {
	"4h": "4時間後",
	"24h": "24時間後",
};

/** 測定中の記事が測れるようになるのを拾う間隔。値動きは足の確定ごとにしか変わらないので、一覧の問い合わせより粗くする */
const POLL_MS = 60_000;

export type ArticlePrecisions = {
	horizon: AccuracyHorizon;
	byId: ReadonlyMap<number, ArticleAccuracy>;
};

/** 一覧に出ている記事の精度。記事が入れ替わるか採点し直したときと、一定の間隔で読み直す */
export function useArticlePrecisions(
	news: readonly NewsItem[],
	active: boolean,
): ArticlePrecisions | null {
	const api = useApi();
	const key = news.map((n) => `${n.id}:${n.score?.rescoredAt ?? ""}`).join(",");
	const [data, setData] = useState<ArticlePrecisions | null>(null);
	const load = useCallback(async () => {
		const ids = key
			.split(",")
			.filter((x) => x !== "")
			.map((x) => x.split(":")[0]);
		try {
			const r = await api.api.scoring.accuracy
				.$get({ query: { ids: ids.join(",") } })
				.then((res) => readJson<ArticleAccuracyReport>(res));
			setData({
				horizon: r.horizon,
				byId: new Map(r.items.map((x) => [x.id, x])),
			});
		} catch {
			// 精度は補足なので、読めなければ出さないだけにする
			setData(null);
		}
	}, [api, key]);
	useEffect(() => {
		if (active) load();
	}, [active, load]);
	useInterval(load, POLL_MS, active);
	return data;
}

/** 記事の精度の1行。持続なし・未採点の記事は API が返さないので出さない */
export function ArticlePrecision({
	value,
	horizon,
}: {
	value: ArticleAccuracy;
	horizon: AccuracyHorizon;
}) {
	return (
		<p data-testid="article-precision" className="text-xs text-text-2">
			精度（{horizon}）{" "}
			{value.status === "ok" ? (
				<>
					センチ <b className="num text-text">{value.sentiment}</b> ・ リスク{" "}
					<b className="num text-text">{value.risk}</b>
				</>
			) : value.status === "measuring" ? (
				"測定中"
			) : (
				"値動き不明"
			)}
		</p>
	);
}
