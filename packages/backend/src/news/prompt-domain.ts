// 採点のプロンプトと、AI の応答の検証。ひな形と出力形式は集計の前提なので固定する

import type {
	Duration,
	Instrument,
	InstrumentScore,
	Scores,
} from "@trading-studio/core";
import {
	COLLECTED_INSTRUMENTS,
	DURATIONS,
	JUDGES,
	SCORE_RANGES,
} from "@trading-studio/core";

/**
 * ひな形。{news}・{criteria}・{instruments} を差し込む。長い文書を先頭に、指示を最後に置く。
 * 1記事1回の呼び出しで、市場全体に1組と、個別に関係する銘柄だけ1組ずつ返させる（ADR 0037。銘柄ごとに呼ぶと回数が銘柄数倍になるため）
 */
export const PROMPT_TEMPLATE = `<news>
{news}
</news>

<criteria>
{criteria}
</criteria>

# 依頼
<news> のニュース1件が暗号資産の相場に与える影響を、<criteria> の基準で採点してください。
採点は、暗号資産の市場全体に1組と、このニュースが個別に関係する銘柄だけ1組ずつ付けます。対象の銘柄: {instruments}

# 出力（この形式以外は受け付けない）
まず duration を決め、次に観点ごとの整数を付ける。
- duration: 相場への影響が続く長さ。none=相場に関係ない / short=数時間（発言・話題・単発の値動き） / medium=1日程度（企業や取引所の発表・ETF の資金の出入り） / long=数日以上（規制・金融政策・大規模な流出）
- sentiment: -100〜100。価格にとって強気材料か弱気材料か。-100=強い弱気材料（下落要因） / 0=中立 / 100=強い強気材料（上昇要因）
- risk: 0〜100。0=安全 / 100=危険
duration が none なら sentiment と risk は 0 にする。それ以外でも関係ない観点は 0 にする。
上の duration・sentiment・risk は市場全体への影響。
instruments には、市場全体とは別に、そのニュースが個別に関係する対象の銘柄だけを入れ、その銘柄への影響を同じ基準で付ける（symbol は対象の銘柄の表記のまま）。個別に関係する銘柄が無ければ空の配列にする。
comment には採点の理由を日本語で書く。

JSON のみを出力: {"duration": "none"|"short"|"medium"|"long", "sentiment": 整数, "risk": 整数, "instruments": [{"symbol": 文字列, "duration": ..., "sentiment": 整数, "risk": 整数}], "comment": 文字列}`;

/** 採点の基準の初版 */
export const DEFAULT_CRITERIA = `- 価格そのものの推移ではなく、ニュースの材料で判断する
- 取引所の障害・規制・ハッキングはリスクを高くする
- 要人発言や指標発表の前後はリスクをやや高くする
- comment には採点の理由を 2 文までで書く`;

export type PromptNews = {
	sourceName: string;
	title: string;
	summary: string | null;
	publishedAt: number;
};

function jst(time: number): string {
	return `${new Date(time + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} JST`;
}

export function buildPrompt(
	news: PromptNews,
	criteria: string,
	instruments: readonly Instrument[] = COLLECTED_INSTRUMENTS,
): string {
	const body = [
		`情報源: ${news.sourceName}`,
		`公開時刻: ${jst(news.publishedAt)}`,
		`見出し: ${news.title}`,
		...(news.summary ? [`概要: ${news.summary}`] : []),
	].join("\n");
	// 差し込む値に {criteria} などが含まれていても二重に置き換えないよう、1回で置き換える
	const values: Record<string, string> = {
		news: body,
		criteria,
		instruments: instruments.map((i) => i.symbol).join("・"),
	};
	return PROMPT_TEMPLATE.replace(
		/\{(news|criteria|instruments)\}/g,
		(_, k: string) => values[k] as string,
	);
}

const SCORE_PROPERTIES = {
	sentiment: {
		type: "INTEGER",
		minimum: SCORE_RANGES.sentiment.min,
		maximum: SCORE_RANGES.sentiment.max,
	},
	risk: {
		type: "INTEGER",
		minimum: SCORE_RANGES.risk.min,
		maximum: SCORE_RANGES.risk.max,
	},
	duration: { type: "STRING", format: "enum", enum: [...DURATIONS] },
} as const;

/** 構造化出力で強制する形（Gemini の responseSchema の書き方） */
export const RESPONSE_SCHEMA = {
	type: "OBJECT",
	properties: {
		...SCORE_PROPERTIES,
		instruments: {
			type: "ARRAY",
			items: {
				type: "OBJECT",
				properties: { symbol: { type: "STRING" }, ...SCORE_PROPERTIES },
				required: ["symbol", "duration", "sentiment", "risk"],
				propertyOrdering: ["symbol", "duration", "sentiment", "risk"],
			},
		},
		comment: { type: "STRING" },
	},
	required: ["duration", "sentiment", "risk", "instruments", "comment"],
	propertyOrdering: ["duration", "sentiment", "risk", "instruments", "comment"],
} as const;

export const COMMENT_MAX = 1000;

export type ScoreResponse = {
	/** 市場全体 */
	scores: Scores;
	duration: Duration;
	/** 個別に関係する銘柄（銘柄の id → 点数）。持続が none の銘柄は個別に関係しないとみなして入れない */
	instruments?: Record<string, InstrumentScore>;
	comment: string;
};

/** 点数と持続を検証する。形が合わなければ理由の文字列。持続が none なら点数を 0 にそろえる（集計に使わないため） */
function parseScore(
	o: Record<string, unknown>,
	where: string,
): InstrumentScore | string {
	const scores = {} as Scores;
	for (const j of JUDGES) {
		const x = o[j];
		const { min, max } = SCORE_RANGES[j];
		if (Number.isInteger(x) && (x as number) >= min && (x as number) <= max) {
			scores[j] = x as number;
		} else {
			return `${where}${j} が ${min}〜${max} の整数でない: ${JSON.stringify(x) ?? "なし"}`;
		}
	}
	const duration = o.duration;
	if (!DURATIONS.includes(duration as Duration)) {
		return `${where}duration が ${DURATIONS.join("・")} のどれでもない: ${JSON.stringify(duration) ?? "なし"}`;
	}
	if (duration === "none") {
		for (const j of JUDGES) scores[j] = 0;
	}
	return { scores, duration: duration as Duration };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** 応答を検証する。形が合わなければ理由の文字列を返す */
export function parseScoreResponse(
	v: unknown,
	instruments: readonly Instrument[] = COLLECTED_INSTRUMENTS,
): ScoreResponse | string {
	if (!isObject(v)) return "応答が JSON のオブジェクトでない";
	const market = parseScore(v, "");
	if (typeof market === "string") return market;
	// 銘柄ごとに採点する前の形（instruments 無し）も受ける
	const list = v.instruments ?? [];
	if (!Array.isArray(list)) return "instruments が配列でない";
	const own: Record<string, InstrumentScore> = {};
	const seen = new Set<string>();
	for (const x of list) {
		if (!isObject(x)) return "instruments の要素がオブジェクトでない";
		const instrument = instruments.find((i) => i.symbol === x.symbol);
		if (!instrument) {
			return `instruments の symbol が対象の銘柄でない: ${JSON.stringify(x.symbol) ?? "なし"}`;
		}
		if (seen.has(instrument.id)) {
			return `instruments に ${instrument.symbol} が2つある`;
		}
		seen.add(instrument.id);
		const score = parseScore(x, `${instrument.symbol} の `);
		if (typeof score === "string") return score;
		if (score.duration !== "none") own[instrument.id] = score;
	}
	if (typeof v.comment !== "string" || v.comment.trim() === "") {
		return "comment が空";
	}
	return {
		...market,
		instruments: own,
		comment: v.comment.trim().slice(0, COMMENT_MAX),
	};
}
