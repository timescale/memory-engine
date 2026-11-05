import { describe, expect, mock, test } from "bun:test";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CliConsentDetails } from "../lib/cli-consent.ts";
import { CliConsentView } from "./CliConsentPage.tsx";

const details: CliConsentDetails = {
  user: { id: "account-123", email: "person@example.com" },
  clientName: "Memory Engine CLI",
  redirectUri: "http://127.0.0.1:54321/callback",
  scopes: ["openid", "profile", "email", "offline_access"],
};

function findButtons(node: ReactNode): Array<{
  disabled: boolean;
  onClick: () => void;
  children: string;
}> {
  const buttons: ReturnType<typeof findButtons> = [];
  Children.forEach(node, (child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return;
    if (child.type === "button") {
      buttons.push(child.props as (typeof buttons)[number]);
    } else {
      buttons.push(...findButtons(child.props.children));
    }
  });
  return buttons;
}

describe("CLI consent rendering", () => {
  test("shows only a loading state before the details have been validated", () => {
    const onDecide = mock(() => {});
    const html = renderToStaticMarkup(
      <CliConsentView state={{ status: "loading" }} onDecide={onDecide} />,
    );
    expect(html).toContain("Verifying authorization request");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Callback address");
    expect(html).not.toContain(details.user.email);
    expect(onDecide).not.toHaveBeenCalled();
  });

  test("shows the validated account, application, scopes, and exact callback", () => {
    const onDecide = mock(() => {});
    const html = renderToStaticMarkup(
      <CliConsentView
        state={{ status: "ready", details }}
        onDecide={onDecide}
      />,
    );
    for (const value of [
      details.user.email,
      details.clientName,
      details.redirectUri,
      ...details.scopes,
      "existing space",
      "does not grant new permissions",
      "claims to be the Memory Engine CLI",
      "verify the identity of the program",
      "Compare this full address, including the port and path",
      "Only authorize if you just ran",
      "me login",
      "someone sent you this link",
      "Cancel",
      "Authorize CLI",
    ]) {
      expect(html).toContain(value);
    }
    expect(html).not.toContain("disabled=");
    expect(onDecide).not.toHaveBeenCalled();
  });

  test("describes offline access only when the validated scope requests it", () => {
    const render = (scopes: string[]) =>
      renderToStaticMarkup(
        <CliConsentView
          state={{ status: "ready", details: { ...details, scopes } }}
          onDecide={() => {}}
        />,
      );
    expect(render(["openid", "offline_access"])).toContain("Offline access:");
    expect(render(["openid"])).not.toContain("Offline access:");
    expect(render(["openid", "not_offline_access"])).not.toContain(
      "Offline access:",
    );
  });

  test("does not render server-provided strings as HTML", () => {
    const html = renderToStaticMarkup(
      <CliConsentView
        state={{
          status: "ready",
          details: {
            ...details,
            clientName: '<script>alert("unsafe")</script>',
          },
        }}
        onDecide={() => {}}
      />,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  test("Cancel and Authorize CLI invoke only their explicit decisions", () => {
    const onDecide = mock((_accept: boolean) => {});
    const buttons = findButtons(
      CliConsentView({ state: { status: "ready", details }, onDecide }),
    );
    expect(onDecide).not.toHaveBeenCalled();
    expect(buttons.map((button) => button.children)).toEqual([
      "Cancel",
      "Authorize CLI",
    ]);
    buttons[0]?.onClick();
    buttons[1]?.onClick();
    expect(onDecide.mock.calls).toEqual([[false], [true]]);
  });

  test("keeps the displayed details and disables both buttons during submission", () => {
    const onDecide = mock(() => {});
    const view = CliConsentView({
      state: { status: "submitting", details },
      onDecide,
    });
    const html = renderToStaticMarkup(view);
    expect(html).toContain(details.user.email);
    expect(html).toContain(details.redirectUri);
    expect(html).toContain("Submitting your decision");
    expect(findButtons(view).map((button) => button.disabled)).toEqual([
      true,
      true,
    ]);
    expect(onDecide).not.toHaveBeenCalled();
  });

  for (const message of [
    "The request expired",
    "Account changed",
    "Client disabled",
    "Sign in first",
  ]) {
    test(`shows a final nonretrying error: ${message}`, () => {
      const onDecide = mock(() => {});
      const html = renderToStaticMarkup(
        <CliConsentView
          state={{ status: "error", message }}
          onDecide={onDecide}
        />,
      );
      expect(html).toContain('role="alert"');
      expect(html).toContain(message);
      expect(html).toContain("Do not reuse this link");
      expect(html).toContain("me login");
      expect(html).not.toContain("<button");
      expect(html).not.toContain(details.user.email);
      expect(onDecide).not.toHaveBeenCalled();
    });
  }
});
