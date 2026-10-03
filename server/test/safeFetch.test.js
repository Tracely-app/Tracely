/* citeMeta.js safeFetch: the fetch behind /api/cite-url and, since the source
 * search stopped asking the model to open pages, behind every page the server
 * reads to complete a citation. Those URLs come from a model reading a
 * student's text, so each hop is resolved and checked. */
import test from "node:test";
import assert from "node:assert/strict";
import { safeFetch, setHostResolver, isPrivateIp, fetchUrlMetadata } from "../lib/citeMeta.js";

const PUBLIC = [{ address: "93.184.216.34" }];
const page = (html = "<html><head><title>Fine</title></head></html>") => new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
const redirect = (to, status = 302) => new Response("", { status, headers: { Location: to } });

test.after(() => setHostResolver(null));

test("isPrivateIp: loopback, RFC1918, link-local, CGNAT, v6 loopback/ULA/link-local, v4-mapped — and not a public address", () => {
  for (const ip of ["127.0.0.1", "127.9.9.9", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "not-an-ip"]) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "172.15.0.1", "100.63.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPrivateIp(ip), false, ip);
});

test("a public name that resolves to a private address is refused before any fetch; so is a private IP literal, a password in the URL, and a non-http scheme", async () => {
  let fetched = 0;
  const fetchImpl = async () => { fetched++; return page(); };
  setHostResolver(async () => [{ address: "127.0.0.1" }]);
  await assert.rejects(safeFetch("https://localtest.example/", {}, { fetchImpl }), /private addresses/);
  setHostResolver(async () => [{ address: "93.184.216.34" }, { address: "10.1.2.3" }]);
  await assert.rejects(safeFetch("https://dual.example/", {}, { fetchImpl }), /private addresses/, "one private answer among several is enough");
  setHostResolver(async () => PUBLIC);
  await assert.rejects(safeFetch("http://169.254.169.254/latest/meta-data/", {}, { fetchImpl }), /private addresses/);
  await assert.rejects(safeFetch("http://[::1]/", {}, { fetchImpl }), /private addresses/);
  await assert.rejects(safeFetch("https://user:pw@example.com/", {}, { fetchImpl }), /password/);
  await assert.rejects(safeFetch("ftp://example.com/x", {}, { fetchImpl }), /Only http/);
  await assert.rejects(safeFetch("file:///etc/passwd", {}, { fetchImpl }), /Only http/);
  assert.equal(fetched, 0, "nothing was fetched");
  setHostResolver(async () => { throw new Error("ENOTFOUND"); });
  await assert.rejects(safeFetch("https://nope.example/", {}, { fetchImpl }), /does not resolve/);
  assert.equal(fetched, 0);
});

test("redirects are followed by hand — each hop checked, at most three — and the final answer is returned with the caller's init", async () => {
  setHostResolver(async (host) => (host === "internal.example" ? [{ address: "10.0.0.5" }] : PUBLIC));
  const seen = [];
  const fetchImpl = async (u, init) => {
    seen.push([String(u), init.redirect, init.headers?.["X-T"]]);
    const s = String(u);
    if (s === "https://a.example/") return redirect("https://b.example/x", 301);
    if (s === "https://b.example/x") return redirect("/y", 302);
    if (s === "https://b.example/y") return page("<title>Landed</title>");
    if (s === "https://evil.example/") return redirect("http://internal.example/admin");
    if (s === "https://loop.example/") return redirect("https://loop.example/");
    return page();
  };
  const res = await safeFetch("https://a.example/", { headers: { "X-T": "1" } }, { fetchImpl });
  assert.equal(res.status, 200);
  assert.deepEqual(seen.map((x) => x[0]), ["https://a.example/", "https://b.example/x", "https://b.example/y"], "relative Location resolved against the hop");
  assert.ok(seen.every((x) => x[1] === "manual" && x[2] === "1"), "manual redirects, caller's headers on every hop");
  await assert.rejects(safeFetch("https://evil.example/", {}, { fetchImpl }), /private addresses/, "a redirect into the private network is refused");
  await assert.rejects(safeFetch("https://loop.example/", {}, { fetchImpl }), /too many redirects/);
  assert.equal(seen.filter((x) => x[0] === "https://loop.example/").length, 4, "the original plus three hops, no more");
});

test("fetchUrlMetadata goes through safeFetch: a private resolution is a clear error, a public page still reads", async () => {
  const fetchImpl = async () => page(`<html><head><title>Sleep | CDC</title><meta property="og:site_name" content="CDC"><meta property="article:published_time" content="2024-05-15"></head></html>`);
  setHostResolver(async () => [{ address: "127.0.0.1" }]);
  await assert.rejects(fetchUrlMetadata("https://www.cdc.gov/sleep/about/index.html", { fetchImpl }), /private addresses/);
  setHostResolver(async () => PUBLIC);
  const m = await fetchUrlMetadata("https://www.cdc.gov/sleep/about/index.html", { fetchImpl });
  assert.equal(m.year, 2024); assert.equal(m.publisher, "CDC");
});
