import { afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// 画面のテストファイルの先頭で import する。DOM はそのファイルの間だけ用意し、backend のテストへ持ち込まない（Response などが happy-dom の実装に置き換わるため）
GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
