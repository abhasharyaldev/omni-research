import { describe, expect, it } from "vitest";
import { isForbiddenIp } from "../src/ip-ranges.js";
import { validateUrlSyntax } from "../src/url-safety.js";

describe("isForbiddenIp", () => {
  it("blocks loopback, private, link-local, CGNAT, multicast, reserved IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "127.255.255.254",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "198.18.0.1",
      "192.0.2.44",
    ]) {
      expect(isForbiddenIp(ip), ip).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.32.0.1", "104.16.0.1"]) {
      expect(isForbiddenIp(ip), ip).toBe(false);
    }
  });

  it("blocks forbidden IPv6 including v4-mapped forms", () => {
    for (const ip of [
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:192.168.0.1",
      "64:ff9b::7f00:1",
      "2001:db8::1",
    ]) {
      expect(isForbiddenIp(ip), ip).toBe(true);
    }
  });

  it("allows public IPv6", () => {
    for (const ip of ["2606:4700:4700::1111", "2620:fe::fe"]) {
      expect(isForbiddenIp(ip), ip).toBe(false);
    }
  });

  it("treats non-IP input as forbidden", () => {
    expect(isForbiddenIp("example.com")).toBe(true);
    expect(isForbiddenIp("")).toBe(true);
  });
});

describe("validateUrlSyntax", () => {
  const bad = (url: string, reason?: string) => {
    const verdict = validateUrlSyntax(url);
    expect(verdict.ok, url).toBe(false);
    if (!verdict.ok && reason) expect(verdict.reason).toBe(reason);
  };

  it("rejects non-http(s) protocols", () => {
    bad("file:///etc/passwd", "forbidden-protocol");
    bad("ftp://example.com/x", "forbidden-protocol");
    bad("gopher://example.com", "forbidden-protocol");
    bad("javascript:alert(1)", "forbidden-protocol");
    bad("data:text/html,hi", "forbidden-protocol");
    bad("ssh://example.com", "forbidden-protocol");
  });

  it("rejects embedded credentials", () => {
    bad("http://user:pass@example.com/", "embedded-credentials");
    bad("http://admin@example.com/", "embedded-credentials");
  });

  it("rejects localhost and internal hostnames", () => {
    bad("http://localhost/", "forbidden-hostname");
    bad("http://localhost:8080/admin", "forbidden-hostname");
    bad("http://foo.localhost/", "forbidden-hostname");
    bad("http://intranet.corp/", "forbidden-hostname");
    bad("http://router.local/", "forbidden-hostname");
    bad("http://metadata.google.internal/computeMetadata/v1/", "forbidden-hostname");
    bad("http://internal-service/", "forbidden-hostname");
  });

  it("rejects literal private IPs including integer/hex encodings", () => {
    bad("http://127.0.0.1/", "forbidden-ip");
    bad("http://10.1.2.3/", "forbidden-ip");
    bad("http://169.254.169.254/latest/meta-data/", "forbidden-ip");
    // WHATWG URL canonicalizes these to 127.0.0.1 before our range check
    bad("http://2130706433/", "forbidden-ip");
    bad("http://0x7f000001/", "forbidden-ip");
    bad("http://017700000001/", "forbidden-ip");
    bad("http://127.1/", "forbidden-ip");
    bad("http://[::1]/", "forbidden-ip");
    bad("http://[::ffff:10.0.0.1]/", "forbidden-ip");
  });

  it("accepts normal public URLs", () => {
    expect(validateUrlSyntax("https://example.com/page?a=1").ok).toBe(true);
    expect(validateUrlSyntax("http://sub.domain.example.org/path").ok).toBe(true);
  });

  it("enforces domain blocklists and allowlists", () => {
    const blocked = validateUrlSyntax("https://bad.example.com/x", {
      blockDomains: ["example.com"],
    });
    expect(blocked.ok).toBe(false);
    const notAllowed = validateUrlSyntax("https://other.org/x", {
      allowDomains: ["example.com"],
    });
    expect(notAllowed.ok).toBe(false);
    const allowed = validateUrlSyntax("https://docs.example.com/x", {
      allowDomains: ["*.example.com"],
    });
    expect(allowed.ok).toBe(true);
  });
});
