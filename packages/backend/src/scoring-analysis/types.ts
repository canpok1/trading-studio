// 市場評価の精度（ニュース画面の記事ごとの精度）の型。app.ts から参照されるため、Bun 固有の型を持ち込まない（docs/news-page.md）

/** 精度を測る、採点時刻からの長さ */
export const ACCURACY_HORIZONS = ["4h", "24h"] as const;
export type AccuracyHorizon = (typeof ACCURACY_HORIZONS)[number];

/** 精度の設定。設定画面の「ニュース」区分の「精度」で変える */
export type AccuracySettings = {
	/** 精度に使う、採点時刻からの長さ */
	horizon: AccuracyHorizon;
	/** センチメントと比べる値動きの段階の境目（%）。測る長さごと */
	sentimentBands: Record<AccuracyHorizon, SentimentBands>;
	/** リスクと比べる値動きの段階の境目（%）。測る長さごと */
	riskBands: Record<AccuracyHorizon, RiskBands>;
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

export interface AccuracyService {
	/** 記事ごとの精度。設定の長さで測る */
	articleAccuracy(ids: readonly number[]): ArticleAccuracyReport;
	accuracySettings(): AccuracySettings;
	setAccuracySettings(s: AccuracySettings): SetAccuracySettingsResult;
}
