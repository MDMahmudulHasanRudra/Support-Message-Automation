import { describe, expect, it } from "vitest";
import { advanceMenu, DEFAULT_MENU_WORDING as W, MENU_BOT_TEMPLATES, menuTreeProblems, menuTriggerMatches, readMenuTree, renderMenuNode, startMenu, type MenuSessionState, type MenuTree } from "../index.js";

const tree: MenuTree = {
  rootId: "root",
  nodes: {
    root: { id: "root", title: "Main", text: "Welcome", kind: "MENU", options: [{ label: "Prices", goTo: "price" }, { label: "More", goTo: "more" }, { label: "Agent", goTo: "human" }] },
    price: { id: "price", title: "Prices", text: "500 taka", kind: "ANSWER", options: [] },
    more: { id: "more", title: "More", text: "Choose", kind: "MENU", options: [{ label: "Address", goTo: "addr" }] },
    addr: { id: "addr", title: "Address", text: "Dhaka", kind: "ANSWER", options: [] },
    human: { id: "human", title: "Human", text: "Someone will reply", kind: "HANDOFF", options: [] },
  },
};
const at = (nodeId: string, path: string[] = [], invalidCount = 0): MenuSessionState => ({ nodeId, path, invalidCount });
const reply = (s: ReturnType<typeof advanceMenu>) => {
  if (s.action !== "REPLY") throw new Error("released");
  return s;
};

describe("reading a customer's answer", () => {
  it("a number picks that choice, in Bangla digits too and with stray punctuation", () => {
    expect(reply(advanceMenu(tree, at("root"), "1", W)).nodeId).toBe("price");
    expect(reply(advanceMenu(tree, at("root"), "১", W)).nodeId).toBe("price");
    expect(reply(advanceMenu(tree, at("root"), "2.", W)).nodeId).toBe("more");
  });
  it("the choice's own words work", () => {
    expect(reply(advanceMenu(tree, at("root"), "prices", W)).nodeId).toBe("price");
  });
  it("0 goes back one step and 00 to the start", () => {
    expect(reply(advanceMenu(tree, at("addr", ["root", "more"]), "0", W)).nodeId).toBe("more");
    const home = reply(advanceMenu(tree, at("addr", ["root", "more"]), "00", W));
    expect(home.nodeId).toBe("root");
    expect(home.state.path).toEqual([]);
  });
  it("a start word inside a menu begins again", () => {
    expect(reply(advanceMenu(tree, at("more", ["root"]), "Menu", W, ["menu"])).event).toBe("RESTART");
  });
});

describe("mistakes", () => {
  it("a wrong number says so and shows the menu again", () => {
    const s = reply(advanceMenu(tree, at("root"), "7", W));
    expect(s.event).toBe("INVALID");
    expect(s.reply).toContain(W.invalidText);
    expect(s.reply).toContain("1. Prices");
    expect(s.state.invalidCount).toBe(1);
  });
  it("too many wrong answers goes to a person", () => {
    const s = reply(advanceMenu(tree, at("root", [], 1), "7", W));
    expect(s.status).toBe("HANDED_OFF");
    expect(s.reply).toBe(W.handoffText);
  });
  it("a real sentence is not a wrong number: it goes on to the rules and AI", () => {
    expect(advanceMenu(tree, at("root"), "my internet is down since morning", W).action).toBe("RELEASE");
  });
  it("words after an answer are not a menu mistake", () => {
    expect(advanceMenu(tree, at("price", ["root"]), "thanks", W).action).toBe("RELEASE");
  });
  it("a step that was deleted lets the customer go", () => {
    expect(advanceMenu(tree, at("gone"), "1", W).action).toBe("RELEASE");
  });
  it("asking for a person works from anywhere", () => {
    expect(reply(advanceMenu(tree, at("addr", ["root"]), "agent", W)).status).toBe("HANDED_OFF");
  });
});

describe("what the customer sees", () => {
  it("numbers the choices and offers back only below the start", () => {
    expect(renderMenuNode(tree.nodes.root!, [], W)).toBe("Welcome\n\n1. Prices\n2. More\n3. Agent");
    expect(renderMenuNode(tree.nodes.more!, ["root"], W)).toContain("0. Back");
  });
  it("a hand-over step closes the session", () => {
    expect(reply(advanceMenu(tree, at("root"), "3", W)).status).toBe("HANDED_OFF");
    expect(startMenu(tree, W)).toMatchObject({ action: "REPLY", event: "STARTED", status: "ACTIVE" });
  });
});

describe("starting", () => {
  it("only when the whole message is the word", () => {
    expect(menuTriggerMatches(["menu", "hi"], " Hi! ")).toBe(true);
    expect(menuTriggerMatches(["menu", "hi"], "hi my bill is wrong")).toBe(false);
  });
});

describe("checking a bot before it goes live", () => {
  it("names a broken choice, an empty step and a placeholder", () => {
    const broken: MenuTree = {
      rootId: "a",
      nodes: {
        a: { id: "a", title: "A", text: "", kind: "MENU", options: [{ label: "X", goTo: "nope" }] },
        b: { id: "b", title: "B", text: "Call [your number]", kind: "ANSWER", options: [] },
      },
    };
    const problems = menuTreeProblems(broken).join(" | ");
    expect(problems).toContain("no message");
    expect(problems).toContain("leads nowhere");
    expect(problems).toContain("placeholder");
  });
  it("refuses a tree it cannot read", () => {
    expect(readMenuTree({ rootId: "x", nodes: {} })).toBeNull();
    expect(readMenuTree("nope")).toBeNull();
  });
  it("every template is well formed, leaving only its placeholders to fill in", () => {
    for (const t of MENU_BOT_TEMPLATES) {
      expect(menuTreeProblems(t.tree).filter((p) => !p.includes("placeholder"))).toEqual([]);
      expect(readMenuTree(JSON.parse(JSON.stringify(t.tree)))).not.toBeNull();
    }
  });
});
