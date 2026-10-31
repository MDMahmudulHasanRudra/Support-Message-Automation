import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { fetchFeed, FeedError, type FeedFetchOptions } from "@/server/social/rss";

/**
 * The RSS fetch's network rules against a local server and a scripted resolver (no database). 127.0.0.1
 * stands in for a PUBLIC address (`allowAddress`), and 10.x for a private one. What must hold:
 *   - the name is resolved once per connection and the socket goes to exactly the address that was checked
 *     (a resolver that answers "public" first and "private" afterwards — DNS rebinding — cannot redirect it);
 *   - a private answer, a mixed answer or a private literal is refused before any request is made;
 *   - every redirect is a new address, checked again; non-web schemes, other ports and long chains refused;
 *   - the 2 MB cap holds after decompression, and only feed-like content is read.
 */

const RSS = `<?xml version="1.0"?><rss><channel><title>Blog</title><item><title>Hello</title><guid>g1</guid><link>https://shop.example.com/1</link></item></channel></rss>`;
const PUBLIC = "127.0.0.1";
const PRIVATE = "10.9.9.9";

let server: http.Server;
let port = 0;
const seen: Array<{ path: string; host: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ path: req.url ?? "", host: req.headers.host ?? "" });
    const url = req.url ?? "";
    const loop = /^\/loop\/(\d+)$/.exec(url);
    if (url === "/feed") res.writeHead(200, { "Content-Type": "application/rss+xml" }).end(RSS);
    else if (url === "/gz") res.writeHead(200, { "Content-Type": "application/xml", "Content-Encoding": "gzip" }).end(gzipSync(RSS));
    else if (url === "/bomb") res.writeHead(200, { "Content-Type": "application/xml", "Content-Encoding": "gzip" }).end(gzipSync(Buffer.alloc(6 * 1024 * 1024, 0x20)));
    else if (url === "/big") res.writeHead(200, { "Content-Type": "application/xml" }).end(Buffer.alloc(2 * 1024 * 1024 + 10, 0x20));
    else if (url === "/html") res.writeHead(200, { "Content-Type": "text/html" }).end("<html></html>");
    else if (url === "/to-private") res.writeHead(302, { Location: "http://internal.example.test/feed" }).end();
    else if (url === "/to-file") res.writeHead(302, { Location: "file:///etc/passwd" }).end();
    else if (url === "/to-port") res.writeHead(302, { Location: "http://blog.example.test:8080/feed" }).end();
    else if (url === "/to-public") res.writeHead(301, { Location: "https://cdn.example.test/feed" }).end();
    else if (loop) res.writeHead(302, { Location: `/loop/${Number(loop[1]) + 1}` }).end();
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, PUBLIC, r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** A scripted resolver: each name answers from its list, call by call (the last answer repeats). */
function resolver(answers: Record<string, string[][]>) {
  const calls: string[] = [];
  const connected: string[] = [];
  const options: FeedFetchOptions = {
    resolve: (hostname, cb) => {
      calls.push(hostname);
      const list = answers[hostname] ?? [];
      const n = calls.filter((h) => h === hostname).length - 1;
      const pick = list[Math.min(n, list.length - 1)] ?? [];
      cb(pick.length ? null : new Error("ENOTFOUND"), pick.map((address) => ({ address, family: 4 })));
    },
    allowAddress: (a) => a === PUBLIC,
    onConnect: (_h, a) => connected.push(a),
    portOverride: port,
  };
  return { options, calls, connected };
}

const refused = async (p: Promise<unknown>, message: RegExp) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(FeedError);
  expect((err as Error).message).toMatch(message);
};

describe("RSS fetch — the connection goes only where the check said", () => {
  it("resolves once and connects to exactly the checked address, even when later answers turn private (DNS rebinding)", async () => {
    const r = resolver({ "blog.example.test": [[PUBLIC], [PRIVATE], [PRIVATE]] });
    const before = seen.length;
    expect(await fetchFeed("http://blog.example.test/feed", r.options)).toContain("<title>Hello</title>");
    expect(r.calls).toEqual(["blog.example.test"]);
    expect(r.connected).toEqual([PUBLIC]);
    expect(seen.slice(before)).toEqual([{ path: "/feed", host: `blog.example.test:${port}` }]);
  });

  it("refuses a private answer, and a mixed public/private answer, before any request is made", async () => {
    const before = seen.length;
    await refused(fetchFeed("http://blog.example.test/feed", resolver({ "blog.example.test": [[PRIVATE]] }).options), /private network/);
    await refused(fetchFeed("http://blog.example.test/feed", resolver({ "blog.example.test": [[PUBLIC, PRIVATE]] }).options), /private network/);
    await refused(fetchFeed("http://blog.example.test/feed", resolver({}).options), /could not be found/);
    expect(seen.length).toBe(before);
  });

  it("refuses a private address written as a literal without resolving anything", async () => {
    const r = resolver({});
    await refused(fetchFeed("http://10.1.2.3/feed", r.options), /private network/);
    await refused(fetchFeed("http://169.254.169.254/latest/meta-data", r.options), /private network/);
    await refused(fetchFeed("http://localhost/feed", r.options), /not a public address/);
    await refused(fetchFeed("http://[::ffff:7f00:1]/feed", r.options), /not a public address/);
    expect(r.calls).toEqual([]);
  });

  it("checks every redirect as a new address: private target, other scheme, other port, and long chains are refused", async () => {
    const r = resolver({ "blog.example.test": [[PUBLIC]], "internal.example.test": [[PRIVATE]] });
    const before = seen.length;
    await refused(fetchFeed("http://blog.example.test/to-private", r.options), /private network/);
    expect(seen.slice(before).map((s) => s.path)).toEqual(["/to-private"]);
    await refused(fetchFeed("http://blog.example.test/to-file", r.options), /redirected somewhere not allowed/);
    await refused(fetchFeed("http://blog.example.test/to-port", r.options), /redirected somewhere not allowed: Only the standard web ports/);
    await refused(fetchFeed("http://blog.example.test/loop/1", r.options), /too many times/);
    expect(seen.filter((s) => s.path.startsWith("/loop/")).length).toBe(4);
  });

  it("follows a redirect to another public name, resolving that name for its own connection", async () => {
    const r = resolver({ "blog.example.test": [[PUBLIC]], "cdn.example.test": [[PUBLIC]] });
    // The second hop is https; the local server speaks plain http, so the connection itself fails — but
    // only after the new name was resolved and checked for its own connection.
    await refused(fetchFeed("http://blog.example.test/to-public", r.options), /could not be reached/);
    expect(r.calls).toEqual(["blog.example.test", "cdn.example.test"]);
  });

  it("caps the body at 2 MB after decompression, reads gzip, and refuses what is not a feed", async () => {
    const r = resolver({ "blog.example.test": [[PUBLIC]] });
    expect(await fetchFeed("http://blog.example.test/gz", r.options)).toContain("<title>Hello</title>");
    await refused(fetchFeed("http://blog.example.test/big", r.options), /too large/);
    await refused(fetchFeed("http://blog.example.test/bomb", r.options), /too large/);
    await refused(fetchFeed("http://blog.example.test/html", r.options), /not a feed/);
  });
});
