import net from "node:net";

/**
 * Returns true when the IP address must never be contacted by the crawler:
 * loopback, private, link-local, multicast, reserved, CGNAT, and cloud
 * metadata ranges, for both IPv4 and IPv6 (including IPv4-mapped IPv6).
 */
export function isForbiddenIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isForbiddenIpv4(ip);
  if (kind === 6) return isForbiddenIpv6(ip);
  // Not a literal IP at all — callers must resolve first. Treat as forbidden.
  return true;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

type Cidr4 = { base: number; maskBits: number };

const FORBIDDEN_V4: Cidr4[] = [
  cidr4("0.0.0.0", 8), // "this network"
  cidr4("10.0.0.0", 8), // private
  cidr4("100.64.0.0", 10), // CGNAT
  cidr4("127.0.0.0", 8), // loopback
  cidr4("169.254.0.0", 16), // link-local (includes cloud metadata 169.254.169.254)
  cidr4("172.16.0.0", 12), // private
  cidr4("192.0.0.0", 24), // IETF protocol assignments
  cidr4("192.0.2.0", 24), // TEST-NET-1
  cidr4("192.88.99.0", 24), // 6to4 relay anycast
  cidr4("192.168.0.0", 16), // private
  cidr4("198.18.0.0", 15), // benchmarking
  cidr4("198.51.100.0", 24), // TEST-NET-2
  cidr4("203.0.113.0", 24), // TEST-NET-3
  cidr4("224.0.0.0", 4), // multicast
  cidr4("240.0.0.0", 4), // reserved + broadcast
];

function cidr4(base: string, maskBits: number): Cidr4 {
  const parsed = ipv4ToInt(base);
  if (parsed === null) throw new Error(`bad cidr base ${base}`);
  return { base: parsed, maskBits };
}

function isForbiddenIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true;
  for (const { base, maskBits } of FORBIDDEN_V4) {
    const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
    if ((value & mask) === (base & mask)) return true;
  }
  return false;
}

/** Expand an IPv6 address into 8 hextets (numbers). Returns null when malformed. */
function expandIpv6(ip: string): number[] | null {
  let address = ip;
  // Strip zone index (fe80::1%eth0)
  const zone = address.indexOf("%");
  if (zone !== -1) address = address.slice(0, zone);

  // IPv4-mapped tail (::ffff:127.0.0.1)
  let v4Tail: number[] | null = null;
  const lastColon = address.lastIndexOf(":");
  if (lastColon !== -1 && address.slice(lastColon + 1).includes(".")) {
    const v4 = ipv4ToInt(address.slice(lastColon + 1));
    if (v4 === null) return null;
    v4Tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    address = address.slice(0, lastColon + 1) + "0:0";
  }

  const doubleColon = address.indexOf("::");
  let groups: string[];
  if (doubleColon !== -1) {
    const head = address.slice(0, doubleColon).split(":").filter(Boolean);
    const tail = address.slice(doubleColon + 2).split(":").filter(Boolean);
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill("0"), ...tail];
  } else {
    groups = address.split(":");
  }
  if (groups.length !== 8) return null;
  const hextets: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    hextets.push(parseInt(group, 16));
  }
  if (v4Tail) {
    hextets[6] = v4Tail[0]!;
    hextets[7] = v4Tail[1]!;
  }
  return hextets;
}

function isForbiddenIpv6(ip: string): boolean {
  const hextets = expandIpv6(ip);
  if (!hextets) return true;
  const [h0] = hextets as [number, ...number[]];

  const isAllZero = hextets.every((h) => h === 0);
  if (isAllZero) return true; // ::
  const isLoopback = hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1;
  if (isLoopback) return true; // ::1

  // IPv4-mapped ::ffff:a.b.c.d and IPv4-translated 64:ff9b::/96 — check embedded v4
  const isV4Mapped = hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
  const isNat64 = h0 === 0x64 && hextets[1] === 0xff9b;
  if (isV4Mapped || isNat64) {
    const v4 = `${hextets[6]! >> 8}.${hextets[6]! & 0xff}.${hextets[7]! >> 8}.${hextets[7]! & 0xff}`;
    return isForbiddenIpv4(v4);
  }

  if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (h0 === 0x2001 && hextets[1] === 0xdb8) return true; // 2001:db8::/32 documentation
  if (h0 === 0x2001 && (hextets[1]! & 0xfff0) === 0) return true; // 2001::/28 teredo/orchid etc.
  return false;
}
