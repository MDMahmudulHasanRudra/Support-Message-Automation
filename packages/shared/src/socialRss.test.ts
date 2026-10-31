import { describe, expect, it } from "vitest";
import { checkFeedUrl, feedItemText, parseFeed } from "./socialRss.js";
import { isPrivateAddress } from "./integrationHub.js";

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

describe("isPrivateAddress — every notation of a non-public address", () => {
  it("refuses private, loopback, link-local, shared, documentation and multicast IPv4", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "0.0.0.0", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "192.0.0.8", "192.0.2.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "255.255.255.255", "300.1.1.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "192.169.0.1"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses an IPv4 private address written as IPv6 (mapped, compatible, hex, NAT64, 6to4)", () => {
    for (const ip of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::FFFF:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:172.16.0.1", "::ffff:100.64.0.1", "::127.0.0.1", "64:ff9b::a00:1", "64:ff9b:1::1", "2002:c0a8:101::1", "[::1]"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("::ffff:93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2002:5db8:d822::1")).toBe(false);
  });

  it("refuses non-public IPv6 ranges and anything unreadable, and never judges a name", () => {
    for (const ip of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "fec0::1", "ff02::1", "2001:db8::1", "2001::1", "100::1", "1:2:3", "1::2::3", "gggg::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:80b::200e"]) expect(isPrivateAddress(ip), ip).toBe(false);
    expect(isPrivateAddress("example.com")).toBe(false);
  });
});
