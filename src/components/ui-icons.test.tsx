/** @vitest-environment jsdom */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon, iconNames, type IconName } from "./ui-icons";

describe("Icon", () => {
  it("renders every clinical navigation icon as inline SVG", () => {
    const { container } = render(
      <div>
        {iconNames.map((name) => <Icon key={name} name={name} size={24} />)}
      </div>,
    );

    const icons = container.querySelectorAll("svg");
    expect(icons).toHaveLength(iconNames.length);
    expect(icons[0]).toHaveAttribute("width", "24");
    expect(icons[0]).toHaveAttribute("height", "24");
    expect(icons[0]).toHaveAttribute("viewBox", "0 0 24 24");
    expect(icons[0]?.querySelector("path")).toBeInTheDocument();
  });

  it("marks untitled icons as decorative and exposes a title when provided", () => {
    const { container, rerender } = render(<Icon name="overview" className="nav-icon" />);
    const decorativeIcon = container.querySelector("svg");

    expect(decorativeIcon).toHaveAttribute("aria-hidden", "true");
    expect(decorativeIcon).toHaveClass("nav-icon");
    expect(decorativeIcon).not.toHaveAttribute("aria-labelledby");

    rerender(<Icon name="search" title="Pesquisar" />);
    const labelledIcon = container.querySelector("svg");

    expect(labelledIcon).toHaveAttribute("role", "img");
    expect(labelledIcon).not.toHaveAttribute("aria-hidden");
    expect(labelledIcon).toHaveAttribute("aria-labelledby");
    expect(container.querySelector("title")).toHaveTextContent("Pesquisar");
  });

  it("fails safely without rendering an SVG for an unknown runtime name", () => {
    const { container } = render(<Icon name={"not-a-clinical-icon" as IconName} />);

    expect(container.querySelector("svg")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
