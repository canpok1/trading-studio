// 採点の常駐処理（news/scorer-domain）に、ニュースの採点のあいだに AI への問い合わせを差し込む口。
// 同じ API キーの回数制限に当たらないよう、問い合わせの間隔をニュースの採点と共有する

import type { ResponseSchema } from "./model-domain";

/** 採点に使うモデルで1回問い合わせる。応答と使ったモデルを返す */
export type AskModel = (
	prompt: string,
	schema: ResponseSchema,
) => Promise<{ value: unknown; model: string }>;

/** 問い合わせ1回分の仕事。失敗の記録は仕事の側で持つ */
export type AiJob = (ask: AskModel) => Promise<void>;

export type AiJobSource = {
	/** 新着のニュースの次に進める仕事（運用で使うもの） */
	urgent(now: number): AiJob | null;
	/** ニュースの採点し直しの後、手が空いたときに進める仕事 */
	background(now: number): AiJob | null;
};
