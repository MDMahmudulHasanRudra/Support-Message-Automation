import { describe, expect, it } from "vitest";
import { checkFeedUrl, feedItemText, parseFeed } from "./socialRss.js";

const RSS = `<?xml version="1.0"?><rss><channel><title>Shop blog</title>
<item><title><![CDATA[Eid offers &amp; more]]></title><link>https://shop.example.com/eid</link>
<guid isPermaLink="false">post-1</guid><pubDate>Thu, 29 Oct 2026 10:00:00 GMT</pubDate>
<description><![CDATA[<p>New <b>arrivals</b> are here.</p><script>alert(1)</script>]]></description></item>
<item><title>Second</title><link>javascript:alert(1)</link></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom post</title>
<link rel="alternate" href="https://blog.example.com/a"/><id>tag:blog,2026:a</id>
<updated>2026-10-28T08:00:00Z</updated><summary>Short &lt;summary&gt;</summary></entry></feed>`;

describe("RSS import", () => {
  it("reads RSS 2.0 items, decoding CDATA and entities, dropping markup and scripts", () => {
    const items = parseFeed(RSS);
    expect(items[0]).toMatchObject({ guid: "post-1", title: "Eid offers & more", link: "https://shop.example.com/eid", summary: "New arrivals are here." });
    expect(items[0]!.publishedAt?.toISOString()).toBe("2026-10-29T10:00:00.000Z");
    // A non-http link is never kept.
    expect(items[1]!.link).toBeNull();
  });
  it("reads Atom entries", () => {
    expect(parseFeed(ATOM)).toEqual([{ guid: "tag:blog,2026:a", title: "Atom post", link: "https://blog.example.com/a", summary: "Short", publishedAt: new Date("2026-10-28T08:00:00Z") }]);
  });
  it("makes draft text from an item", () => {
    const item = parseFeed(RSS)[0]!;
    expect(feedItemText(item, { includeSummary: true, prefix: "New on our blog:" })).toBe("New on our blog:\n\nEid offers & more\n\nNew arrivals are here.\n\nhttps://shop.example.com/eid");
    expect(feedItemText(item, { includeSummary: false })).toBe("Eid offers & more\n\nhttps://shop.example.com/eid");
  });
  it("refuses addresses that are not public web feeds", () => {
    expect(checkFeedUrl("https://shop.example.com/feed").ok).toBe(true);
    for (const bad of ["ftp://x.com/feed", "https://user:pw@x.com/feed", "http://localhost/feed", "http://intranet/feed", "https://x.com:8443/feed", "not a url"]) {
      expect(checkFeedUrl(bad).ok).toBe(false);
    }
  });
});
