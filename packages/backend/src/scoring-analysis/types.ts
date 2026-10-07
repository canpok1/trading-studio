// 市場評価の精度（ニュース画面の記事ごとの精度と、評価詳細のタブの集計）の型。app.ts から参照されるため、Bun 固有の型を持ち込まない（docs/news-page.md）

import type { Judge, JudgmentValue } from "@trading-studio/core";

/** 精度を測る、採点時刻からの長さ */
export const ACCURACY_HORIZONS = ["4h", "24h"] as const;
export type AccuracyHorizon = (typeof ACCURACY_HORIZONS)[number];

/** 精度を集計する期間（日）。null はすべて */
export const ACCURACY_PERIODS = [7, 30, 90, null] as const;
export type AccuracyPeriod = (typeof ACCURACY_PERIODS)[number];

/** 精度の設定。設定画面の「ニュース」区分の「精度」で変える */
export type AccuracySettings = {
	/** 精度に使う、採点時刻からの長さ */
	horizon: AccuracyHorizon;
	/** センチメントと比べる値動きの段階の境目（%）。測る長さごと */
	sentimentBands: Record<AccuracyHorizon, SentimentBands>;
	/** リスクと比べる値動きの段階の境目（%）。測る長さごと */
	riskBands: Record<AccuracyHorizon, RiskBands>;
	/** 評価詳細のタブで精度を集計する期間。採点時刻で測る */
	periodDays: AccuracyPeriod;
};

/**
 * 値動きの大きさ（上下は問わない）を5段階に分ける境目（%）。それぞれの段階の始まり。
 * slight 未満が静か、slight 以上がやや荒れ、rough 以上が荒れた、heavy 以上がかなり荒れ、wild 以上が大荒れ
 */
export type RiskBands = {
	slight: number;
	rough: number;
	heavy: number;
	wild: number;
};

/**
 * 値動きを5段階に分ける境目（%、上下とも同じ幅）。
 * small 未満が横ばい、small 以上 large 未満が上昇・下落、large 以上が大きく上昇・大きく下落
 */
export type SentimentBands = { small: number; large: number };

export const DEFAULT_ACCURACY_SETTINGS: AccuracySettings = {
	horizon: "24h",
	sentimentBands: {
		"4h": { small: 0.2, large: 0.7 },
		"24h": { small: 0.5, large: 2 },
	},
	riskBands: {
		"4h": { slight: 0.4, rough: 0.7, heavy: 1.1, wild: 1.8 },
		"24h": { slight: 1, rough: 2, heavy: 3, wild: 5 },
	},
	periodDays: 30,
};

/** 値動きの段階の境目の上限（%） */
export const ACCURACY_BAND_MAX = 50;

/** 一度に精度を求められる記事の数の上限。ニュースの一覧の上限と合わせる */
export const ACCURACY_IDS_MAX = 1000;

export type SetAccuracySettingsResult =
	| { ok: true }
	| { ok: false; message: string; field: keyof AccuracySettings };

/**
 * 記事ごとの精度。運用の採点の点数と、採点時刻から測る長さの後の値動きの段階のずれで 5〜1（一致で 5、1段ずれるごとに 1 下げる）。
 * measuring: 測る長さがまだたっていない / unknown: たったが価格が無い
 */
export type ArticleAccuracy =
	| { id: number; status: "ok"; sentiment: number; risk: number }
	| { id: number; status: "measuring" | "unknown" };

export type ArticleAccuracyReport = {
	horizon: AccuracyHorizon;
	/** 精度を出せる記事だけ。採点済みでない記事・持続なしの記事は含めない */
	items: ArticleAccuracy[];
};

/** 観点ごとの精度の集計。精度 5〜1 ごとの件数と、その内訳の記事の点数の段階ごとの件数 */
export type AccuracySummaryResult<J extends Judge = Judge> = {
	/** 精度を出せた記事の数 */
	count: number;
	/** 精度の平均（小数1桁）。0 件は null */
	average: number | null;
	/** 精度の高い順（5〜1）。0 件の精度も含める */
	rows: {
		precision: number;
		count: number;
		/** 記事の点数を今の評価基準に当てた段階ごとの件数。並びは JUDGMENT_VALUES と同じで、0 件の段階も含める */
		levels: { value: JudgmentValue<J>; count: number }[];
	}[];
	/**
	 * 記事の点数の段階 × 値動きの段階の件数。並びは JUDGMENT_VALUES と同じで、0 件の段階も含める。
	 * moves は値動きの段階の番号（0〜4）ごとの件数。センチメントは 0 が大きく下落〜4 が大きく上昇、リスクは 0 が静か〜4 が大荒れ
	 */
	matrix: { value: JudgmentValue<J>; moves: number[] }[];
};

export type AccuracySummary = {
	horizon: AccuracyHorizon;
	periodDays: AccuracyPeriod;
	/** 集計の時点。採点時刻がこれ以前で、期間内の記事を数える */
	time: number;
	results: { [J in Judge]: AccuracySummaryResult<J> };
};

export interface AccuracyService {
	/** 記事ごとの精度。設定の長さで測る */
	articleAccuracy(ids: readonly number[]): ArticleAccuracyReport;
	/** 設定の期間に採点した記事の精度の集計。測定中・値動き不明・持続なしの記事は数えない */
	accuracySummary(at?: number): AccuracySummary;
	accuracySettings(): AccuracySettings;
	setAccuracySettings(s: AccuracySettings): SetAccuracySettingsResult;
}
