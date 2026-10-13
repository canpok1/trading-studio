import { afterAll, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * 画面のテストファイルの先頭で呼ぶ。DOM はそのファイルの間だけ用意し、backend のテストへ持ち込まない（Response などが happy-dom の実装に置き換わるため）。
 * import した時点で用意する形にしないのは、モジュールが1度しか評価されず、2つ目以降のファイルで用意されないため
 */
export function setupDom() {
	beforeAll(() => GlobalRegistrator.register());
	afterAll(() => GlobalRegistrator.unregister());
}
