import { describe, expect, it } from "vitest";
import {
  buildContactAiPrompt,
  contactIdentifierHref,
  coordinatesFromMapUrl,
  extractContactIdentifiers,
  guessContactImportMapping,
  normalizeContactIdentifier,
  phoneFromChatId,
  readContactAiAnswer,
  readContactFields,
  readContactImportRows,
  readMapUrl,
  renderContactCampaignText,
  unknownCampaignVariables,
} from "../index.js";

const norm = (kind: Parameters<typeof normalizeContactIdentifier>[0], raw: string) => {
  const r = normalizeContactIdentifier(kind, raw);
  return "error" in r ? null : r.normalized;
};

describe("one value, however it was written", () => {
  it("a Bangladeshi number is the same with or without the country code", () => {
    expect(norm("PHONE", "01711-000111")).toBe("8801711000111");
    expect(norm("PHONE", "+880 1711 000111")).toBe("8801711000111");
    expect(norm("PHONE", "০১৭১১০০০১১১")).toBe("8801711000111");
  });
  it("a phone number is not text", () => {
    expect(norm("PHONE", "call me")).toBeNull();
    expect(norm("PHONE", "123")).toBeNull();
  });
  it("an email ignores case", () => {
    expect(norm("EMAIL", "Name@Example.COM")).toBe("name@example.com");
    expect(norm("EMAIL", "not-an-email")).toBeNull();
  });
  it("a profile link and its handle are the same account", () => {
    expect(norm("FACEBOOK", "https://www.facebook.com/Nusrat.J?ref=abc")).toBe("nusrat.j");
    expect(norm("FACEBOOK", "@nusrat.j")).toBe("nusrat.j");
    expect(norm("INSTAGRAM", "instagram.com/shop.bd/")).toBe("shop.bd");
    expect(norm("TELEGRAM", "https://t.me/ShopBD")).toBe("shopbd");
  });
  it("refuses another site's link under an app's name", () => {
    expect(norm("INSTAGRAM", "https://facebook.com/x")).toBeNull();
  });
});

describe("links built from stored values", () => {
  it("only ever https, tel or mailto", () => {
    expect(contactIdentifierHref("PHONE", "+8801711000111")).toBe("tel:+8801711000111");
    expect(contactIdentifierHref("INSTAGRAM", "shop.bd")).toBe("https://www.instagram.com/shop.bd");
    expect(contactIdentifierHref("WEBSITE", "example.com/a")).toBe("https://example.com/a");
    expect(contactIdentifierHref("OTHER", "javascript:alert(1)")).toBeNull();
  });
  it("a map link must be a web address", () => {
    expect(readMapUrl("javascript:alert(1)")).toBeNull();
    expect(readMapUrl("https://maps.google.com/?q=23.81,90.41")).toContain("https://");
    expect(readContactFields({ mapUrl: "javascript:alert(1)" })).toEqual({ error: expect.stringContaining("https") });
  });
  it("reads coordinates out of a copied map link", () => {
    expect(coordinatesFromMapUrl("https://www.google.com/maps/@23.8103,90.4125,15z")).toEqual({ latitude: 23.8103, longitude: 90.4125 });
  });
});

describe("pasting from a chat", () => {
  it("finds every number, address and link, once each", () => {
    const found = extractContactIdentifiers("call ০১৮১২৩৪৫৬৭৮ or 01812345678, also 01911 222333. mail a@b.co https://fb.com/nusrat @shop_bd");
    expect(found.map((f) => `${f.kind}:${f.normalized}`)).toEqual(["PHONE:8801812345678", "PHONE:8801911222333", "EMAIL:a@b.co", "FACEBOOK:nusrat", "OTHER:@shop_bd"]);
  });
  it("two numbers side by side are two numbers", () => {
    expect(extractContactIdentifiers("01711000111 01811000222").map((f) => f.normalized)).toEqual(["8801711000111", "8801811000222"]);
  });
  it("finds nothing in ordinary words", () => {
    expect(extractContactIdentifiers("thanks, the internet is working now")).toEqual([]);
  });
});

describe("what a WhatsApp chat proves", () => {
  it("a phone id is a number, a LID is not", () => {
    expect(phoneFromChatId("8801711000111@c.us")?.normalized).toBe("8801711000111");
    expect(phoneFromChatId("190123456789012@lid")).toBeNull();
    expect(phoneFromChatId("120363000000000000@g.us")).toBeNull();
  });
});

describe("the AI's answer", () => {
  const message = "I am Nusrat, my number is 01711000111. Order 88877766655";
  const candidates = extractContactIdentifiers(message);
  it("the prompt lists the values by number", () => {
    expect(buildContactAiPrompt(message, candidates)).toContain("1. +8801711000111");
  });
  it("keeps only what it points at", () => {
    const r = readContactAiAnswer('{"name":"Nusrat","keep":[1]}', message, candidates);
    expect(r?.identifiers.map((i) => i.normalized)).toEqual(["8801711000111"]);
    expect(r?.name).toBe("Nusrat");
  });
  it("cannot add a value that is not in the message", () => {
    const r = readContactAiAnswer('{"name":"Hacker","keep":[99,"01999999999"],"phones":["01999999999"]}', message, candidates);
    expect(r?.identifiers).toEqual([]);
    expect(r?.name).toBeNull();
  });
  it("an unreadable answer is nothing", () => {
    expect(readContactAiAnswer("sorry", message, candidates)).toBeNull();
  });
});

describe("importing", () => {
  it("recognises common headings and leaves the rest blank", () => {
    expect(guessContactImportMapping(["Full Name", "Mobile", "E-mail", "Favourite colour"])).toEqual(["name", "phone", "email", ""]);
  });
  it("several numbers in a cell, and a bad value does not lose the row", () => {
    const [row] = readContactImportRows([["Tanvir", "01711000111, 01811000222", "nope"]], ["name", "phone", "email"]);
    expect(row!.identifiers.map((i) => i.normalized)).toEqual(["8801711000111", "8801811000222"]);
    expect(row!.problems).toHaveLength(1);
  });
  it("a row with nothing says so", () => {
    const [row] = readContactImportRows([["", ""]], ["name", "phone"]);
    expect(row!.problems[0]).toContain("no name");
  });
});

describe("a campaign's message", () => {
  const person = { name: "Nusrat Jahan", company: null, serial: 12 };
  it("is filled in for each person", () => {
    expect(renderContactCampaignText("Hi {{first_name}} ({{serial}})", person)).toBe("Hi Nusrat (CT-0012)");
    expect(renderContactCampaignText("Hi {{name}}", { ...person, name: null })).toBe("Hi there");
  });
  it("a typo is named, not sent as a gap", () => {
    expect(unknownCampaignVariables("Hi {{frist_name}} {{name}}")).toEqual(["frist_name"]);
  });
});
