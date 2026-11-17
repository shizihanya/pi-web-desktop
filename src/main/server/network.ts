import { networkInterfaces } from "node:os";

/** 虚拟网卡/隧道通常不是手机能访问的地址，列出来只会误导 */
const SKIP_IFACE = /(loopback|virtual|vmware|virtualbox|hyper-v|vethernet|wsl|docker|tailscale|zerotier|tap|tun|npcap|bluetooth)/i;

export interface LanAddress {
  name: string;
  address: string;
  url: string;
}

/**
 * 枚举局域网可访问地址（给手机/其他电脑用）。
 * 只取 IPv4 私有地址，跳过回环、链路本地与常见虚拟网卡。
 */
export function listLanAddresses(port: number): LanAddress[] {
  const result: LanAddress[] = [];
  const interfaces = networkInterfaces();

  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses) continue;
    if (SKIP_IFACE.test(name)) continue;
    for (const address of addresses) {
      if (address.family !== "IPv4") continue;
      if (address.internal) continue;
      if (address.address.startsWith("169.254.")) continue;
      if (!isPrivateIpv4(address.address)) continue;
      result.push({
        name,
        address: address.address,
        url: `http://${address.address}:${port}`,
      });
    }
  }

  return result.sort((a, b) => a.address.localeCompare(b.address));
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}
