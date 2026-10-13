import { expect, test } from "bun:test";
import { nextRunTime } from "./retention-domain";

const DAY = 86_400_000;
// JST 2026-09-28 04:00
const RUN_AT = Date.UTC(2026, 8, 27, 19);

test("次の実行は 4:00（JST）", () => {
	expect(nextRunTime(RUN_AT - 1)).toBe(RUN_AT);
	expect(nextRunTime(RUN_AT)).toBe(RUN_AT + DAY);
	expect(nextRunTime(RUN_AT + 1)).toBe(RUN_AT + DAY);
});
