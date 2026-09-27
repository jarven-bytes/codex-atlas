import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { Feedback } from "../../src/client/components/Feedback";

afterEach(() => {
  cleanup();
  delete window.codexAtlas;
});

test("opens only the requested feedback type, without sending project data", async () => {
  const user = userEvent.setup();
  const openFeedback = vi.fn().mockResolvedValue(undefined);
  window.codexAtlas = { openFeedback, openSuggestion: vi.fn() };
  render(<Feedback />);
  await user.click(screen.getByText("Send feedback"));
  expect(screen.getByText(/GitHub issues are public/)).toBeVisible();
  await user.click(screen.getByRole("link", { name: "Report a bug" }));
  expect(openFeedback).toHaveBeenCalledExactlyOnceWith("bug");
  expect(document.querySelector("details")).not.toHaveAttribute("open");
  await user.click(screen.getByText("Send feedback"));
  await user.click(screen.getByRole("link", { name: "Suggest a feature" }));
  expect(openFeedback).toHaveBeenLastCalledWith("feature");
});

test("shows an actionable error and supports Escape dismissal", async () => {
  const user = userEvent.setup();
  window.codexAtlas = { openFeedback: vi.fn().mockRejectedValue(new Error("blocked")), openSuggestion: vi.fn() };
  render(<Feedback />);
  await user.click(screen.getByText("Send feedback"));
  await user.click(screen.getByRole("link", { name: "Report a bug" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not open GitHub");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(document.querySelector("details")).not.toHaveAttribute("open");
  expect(screen.getByText("Send feedback").closest("summary")).toHaveFocus();
});
