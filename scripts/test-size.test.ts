import { expect, test } from "bun:test";
import { sizeOf } from "./test-size";

test("先頭のコメントに medium の印があれば Medium", () => {
	expect(sizeOf('/** @module-tag medium */\nimport "x";')).toBe("medium");
	expect(sizeOf("/**\n * 説明\n * @module-tag medium\n */\n")).toBe("medium");
});

test("印が無ければ Small", () => {
	expect(sizeOf('import "x";')).toBe("small");
	expect(sizeOf("/** 説明だけ */\n")).toBe("small");
});

test("先頭以外にある印は数えない", () => {
	expect(sizeOf('import "x";\n/** @module-tag medium */\n')).toBe("small");
});

test("未知の印はエラー", () => {
	expect(() => sizeOf("/** @module-tag large */\n")).toThrow("large");
});
