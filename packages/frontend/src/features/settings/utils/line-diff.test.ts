import { expect, test } from "bun:test";
import { lineDiff } from "./line-diff";

test("追加・削除・共通の行を並べる", () => {
	expect(lineDiff("a\nb\nc", "a\nx\nc\nd")).toEqual([
		{ kind: "same", text: "a" },
		{ kind: "del", text: "b" },
		{ kind: "add", text: "x" },
		{ kind: "same", text: "c" },
		{ kind: "add", text: "d" },
	]);
	expect(lineDiff("a", "a")).toEqual([{ kind: "same", text: "a" }]);
});
