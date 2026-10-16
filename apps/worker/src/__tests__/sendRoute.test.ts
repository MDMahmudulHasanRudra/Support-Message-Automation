import { describe, expect, it } from "vitest";
import { chooseSendRoute } from "../provider/WhatsAppProvider.js";

/** Pure — safe on any database. Which library call a send needs (CHAT_UI_V2.md §4). */
describe("chooseSendRoute", () => {
  it("keeps every existing send on its existing path", () => {
    expect(chooseSendRoute(undefined)).toBe("TEXT");
    expect(chooseSendRoute([])).toBe("TEXT");
    expect(chooseSendRoute([], { quotedMessageId: null })).toBe("TEXT");
    expect(chooseSendRoute(["8801712345678@c.us"])).toBe("MENTIONS");
  });

  it("sends a quote as a real reply", () => {
    expect(chooseSendRoute(undefined, { quotedMessageId: "false_120363@g.us_ABC_8801@c.us" })).toBe("REPLY");
    expect(chooseSendRoute([], { quotedMessageId: "true_8801@c.us_ABC" })).toBe("REPLY");
  });

  it("refuses a quote that also tags people rather than dropping either half", () => {
    expect(chooseSendRoute(["8801712345678@c.us"], { quotedMessageId: "true_x@g.us_ABC" })).toBe("REFUSE_REPLY_WITH_MENTIONS");
  });
});
