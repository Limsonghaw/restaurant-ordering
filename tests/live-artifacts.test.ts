import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("CI forbidden scan covers the PR-B mock markers and retains existing markers", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const pattern = workflow.match(/const forbidden = \/(.+)\/;/)![1];
  const forbidden = new RegExp(pattern);
  for (const marker of [
    "开发用模拟控制面板",
    "mock-trigger",
    "ro-mock:state",
    "mock-captcha-ok",
    "ro-mock:live-b",
    "mock-live-device",
  ])
    expect(forbidden.test(`const value = "${marker}";`)).toBe(true);
  expect(forbidden.test('const value = "production";')).toBe(false);
});
