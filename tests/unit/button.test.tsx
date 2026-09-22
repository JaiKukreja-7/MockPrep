import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui";

describe("Button", () => {
  it("is a <button type=button> by default, with the variant and size classes", () => {
    const html = renderToStaticMarkup(<Button variant="outline" size="compact">Go</Button>);
    expect(html).toBe('<button type="button" class="button button-outline button-compact">Go</button>');
  });

  it("with href it is one anchor carrying the button's styles — no button inside a link", () => {
    const html = renderToStaticMarkup(<Button href="/dashboard">Start a round</Button>);
    expect(html).toBe('<a class="button button-filled" href="/dashboard">Start a round</a>');
    expect(html).not.toMatch(/<button/);
  });
});
