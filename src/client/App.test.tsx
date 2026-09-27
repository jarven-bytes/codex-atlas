import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { clientApi } from "./api";

vi.mock("./api", () => ({
  clientApi: {
    listProjects: vi.fn().mockResolvedValue({ projects: [] }),
    acceptSuggestion: vi.fn()
  }
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(clientApi.listProjects).mockResolvedValue({ projects: [] });
});

test("renders the dashboard heading at the root shell", async () => {
  render(<App />);

  expect(screen.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  expect(await screen.findByText("No active projects yet.")).toBeVisible();
});
