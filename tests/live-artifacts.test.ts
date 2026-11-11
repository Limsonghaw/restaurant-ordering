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
    "ro-mock:auth-c-v1",
    "ro-mock:upload-probe",
    "切换模拟身份",
    "@demo.test",
  ])
    expect(forbidden.test(`const value = "${marker}";`)).toBe(true);
  expect(forbidden.test('const value = "production";')).toBe(false);
});

it("R-3 扫描脚本逐目录计数并拒绝空产物", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  expect(workflow).toContain("count += check(path)");
  expect(workflow).toContain("count++");
  expect(workflow).toContain("if (count === 0) throw new Error");
  expect(workflow).toContain(
    "['.next/static', '.next/server/app', '.next/server/chunks']",
  );
});
