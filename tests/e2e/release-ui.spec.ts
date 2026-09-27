import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "playwright/test";

for (const viewport of [{ width: 1440, height: 1000 }, { width: 960, height: 640 }]) {
  test(`desktop layout and controls at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.clock.setFixedTime(new Date("2026-08-20T13:00:00Z"));
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    const table = page.getByRole("table", { name: "Projects", exact: true });
    await expect(table.getByRole("row")).toHaveCount(7);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    const statusCells = await table.locator("tbody tr").evaluateAll((rows) => rows.map((row) => {
      const name = row.querySelector(".project-name-copy")!.getBoundingClientRect();
      const status = row.querySelector("td:nth-child(2)")!.getBoundingClientRect();
      return name.right <= status.left + 1;
    }));
    expect(statusCells.every(Boolean)).toBe(true);
    const panels = await page.locator(".dashboard-overview > .dashboard-section").evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      }));
    expect(panels[0].right <= panels[1].left + 1 || panels[0].bottom <= panels[1].top + 1).toBe(true);
    await page.getByRole("button", { name: "Need 2 projects", exact: true }).click();
    await expect(table.getByRole("row")).toHaveCount(3);
    await page.getByRole("button", { name: "Show all projects" }).click();
    await expect(table.getByRole("row")).toHaveCount(7);
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeFocused();
    await page.getByRole("button", { name: "Dashboard", exact: true }).click();
    const footer = page.locator(".rail-footer");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(footer).toBeInViewport();
    await page.getByRole("button", { name: "Collapse navigation" }).click();
    await expect(footer).toBeHidden();
    await page.getByRole("button", { name: "Expand navigation" }).click();
    await expect(footer).toBeVisible();
    await page.locator(".feedback-control summary").click();
    const feedback = page.getByRole("group", { name: "Send feedback" });
    await expect(feedback).toBeVisible();
    await expect(feedback.getByRole("link", { name: "Report a bug" })).toHaveAttribute(
      "href", "https://github.com/jarven-bytes/codex-atlas/issues/new?template=bug_report.md"
    );
    await expect(feedback.getByRole("link", { name: "Suggest a feature" })).toHaveAttribute(
      "href", "https://github.com/jarven-bytes/codex-atlas/issues/new?template=feature_request.md"
    );
    await expect(feedback.getByText(/GitHub issues are public/)).toBeVisible();
    await expect(feedback).toBeInViewport();
    await page.screenshot({ path: `test-results/feedback-${viewport.width}.png` });
    await page.keyboard.press("Escape");
    await expect(feedback).toBeHidden();
    await expect(page.locator(".feedback-control summary")).toBeFocused();
    await page.getByRole("checkbox", { name: "Dark mode" }).check();
    await expect(page.locator(".dashboard-shell")).toHaveClass(/theme-dark/u);
    await page.locator(".feedback-control summary").click();
    await expect(feedback).toBeVisible();
    await page.screenshot({ path: `test-results/feedback-dark-${viewport.width}.png` });
    await page.keyboard.press("Escape");
    await page.getByRole("checkbox", { name: "Dark mode" }).uncheck();
    await page.getByRole("heading", { name: "Dashboard", level: 1 }).focus();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `test-results/release-${viewport.width}.png` });
    if (viewport.width === 1440) {
      await mkdir(path.resolve("docs/images"), { recursive: true });
      await page.screenshot({ path: "docs/images/dashboard.png" });
    }
    expect(errors).toEqual([]);
  });
}
