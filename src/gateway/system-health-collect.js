// Daemon-only read-only Linux telemetry. No subprocesses, device opens, serials or temperatures.
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const number = (v) => v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
const label = (value) => value == null ? null : value.slice(0, 256);
const percent = (used, total) => used != null && total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : null;
export function parseCpuStat(text) {
  const values = text?.match(/^cpu\s+(.+)$/m)?.[1].trim().split(/\s+/).slice(0, 8).map(Number);
  if (!values || values.length < 4 || values.some((v) => !Number.isFinite(v) || v < 0)) return null;
  return { total: values.reduce((a, b) => a + b, 0), idle: values[3] + (values[4] || 0), counters: values };
}
export function cpuUsage(previous, current) {
  if (!previous || !current || current.total <= previous.total || current.idle < previous.idle) return null;
  // Linux documents decreasing iowait counters; treat any reset as a new baseline.
  if (current.counters?.some((v, i) => v < (previous.counters?.[i] ?? 0))) return null;
  return percent(current.total - previous.total - (current.idle - previous.idle), current.total - previous.total);
}
export function parseMeminfo(text) {
  const values = Object.fromEntries([...String(text || "").matchAll(/^(\w+):\s+(\d+)\s+kB$/gm)].map((m) => [m[1], Number(m[2]) * 1024]));
  const total = values.MemTotal ?? null;
  const used = total != null && values.MemAvailable != null ? Math.max(0, total - values.MemAvailable) : null;
  const swap = values.SwapTotal ?? null;
  return { memoryTotalBytes: total, memoryUsedBytes: used, memoryPercent: percent(used, total), swapTotalBytes: swap,
    swapUsedBytes: swap != null && values.SwapFree != null ? Math.max(0, swap - values.SwapFree) : null };
}
export function storageStats(stats, storagePath) {
  const total = Number(stats.blocks) * Number(stats.bsize);
  const free = Number(stats.bfree) * Number(stats.bsize);
  const available = Number(stats.bavail) * Number(stats.bsize);
  if (![total, free, available].every(Number.isFinite) || total <= 0) throw new Error("invalid filesystem statistics");
  const used = Math.max(0, total - free);
  // Include reserved blocks in the denominator exactly like df's user-visible capacity.
  return { storageUsedBytes: used, storageTotalBytes: total, storageAvailableBytes: Math.max(0, available),
    storagePercent: percent(used, used + Math.max(0, available)), storagePath };
}

export function createLinuxHealthCollector({ io = fs, now = Date.now, storagePath, system = os } = {}) {
  let previousCpu = null;
  const read = async (file) => { try { return (await io.readFile(file, "utf8")).trim().slice(0, 262144); } catch { return null; } };
  const entries = async (dir) => { try { return (await io.readdir(dir)).sort().slice(0, 128); } catch { return []; } };
  const linkName = async (file) => { try { return path.basename(await io.readlink(file)); } catch { return null; } };
  async function collect() {
    const [stat, mem, load, disk] = await Promise.all([read("/proc/stat"), read("/proc/meminfo"), read("/proc/loadavg"),
      io.statfs(storagePath).then((value) => storageStats(value, storagePath)).catch(() => null)]);
    const cpu = parseCpuStat(stat);
    const memory = parseMeminfo(mem);
    const loads = load?.split(/\s+/).slice(0, 3).map((value) => { const n = number(value); return n != null && n >= 0 ? n : null; }) || [];
    const logicalCpus = stat?.match(/^cpu\d+\s/gm)?.length || null;
    const errors = [!cpu && "CPU", memory.memoryUsedBytes == null && "memory", (loads.length !== 3 || loads.some((v) => v == null || v < 0)) && "load", !disk && "storage"].filter(Boolean);
    const sample = { timestamp: now(), cpuPercent: cpuUsage(previousCpu, cpu), ...memory,
      load1: loads[0] ?? null, load5: loads[1] ?? null, load15: loads[2] ?? null, logicalCpus,
      storageUsedBytes: null, storageTotalBytes: null, storageAvailableBytes: null, storagePercent: null, storagePath, ...disk };
    previousCpu = cpu;
    return { sample, error: errors.length ? `Unavailable telemetry: ${errors.join(", ")}` : null };
  }
  async function hardware() {
    const [cpuText, cpuStat, mem, osRelease, mounts, names, pciNames, networkNames, ...dmi] = await Promise.all([
      read("/proc/cpuinfo"), read("/proc/stat"), read("/proc/meminfo"), read("/etc/os-release"), read("/proc/self/mountinfo"),
      entries("/sys/block"), entries("/sys/bus/pci/devices"), entries("/sys/class/net"),
      ...["board_vendor", "board_name", "bios_vendor", "bios_version"].map((name) => read(`/sys/class/dmi/id/${name}`)),
    ]);
    const cpus = (cpuText || "").split(/\n\s*\n/).filter(Boolean).map((block) => Object.fromEntries(block.split("\n").filter((l) => l.includes(":")).map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })));
    const logicalCpus = cpuStat?.match(/^cpu\d+\s/gm)?.length || null;
    if (!logicalCpus && !mem) throw new Error("Host inventory sources unavailable");
    const completeTopology = logicalCpus != null && cpus.length === logicalCpus;
    const sockets = new Set(cpus.map((c) => c["physical id"]).filter((v) => v != null));
    const cores = new Set(cpus.filter((c) => c["core id"] != null).map((c) => `${c["physical id"] ?? "0"}:${c["core id"]}`));
    const disks = await Promise.all(names.filter((n) => !/^(loop|ram|zram)/.test(n)).map(async (name) => {
      const [model, size, rotational] = await Promise.all([read(`/sys/block/${name}/device/model`), read(`/sys/block/${name}/size`), read(`/sys/block/${name}/queue/rotational`)]);
      return { name, model: label(model), sizeBytes: number(size) == null ? null : number(size) * 512, rotational: rotational === "1" ? true : rotational === "0" ? false : null };
    }));
    const gpus = (await Promise.all(pciNames.map(async (name) => {
      const base = `/sys/bus/pci/devices/${name}`;
      if (!(await read(`${base}/class`))?.startsWith("0x03")) return null;
      const [vendor, device, driver] = await Promise.all([read(`${base}/vendor`), read(`${base}/device`), linkName(`${base}/driver`)]);
      return { vendor, device, driver };
    }))).filter(Boolean);
    const network = (await Promise.all(networkNames.filter((n) => n !== "lo").map(async (name) => {
      const driver = await linkName(`/sys/class/net/${name}/device/driver`);
      return driver ? { name, driver } : null;
    }))).filter(Boolean);
    const decode = (s) => s.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
    const mount = (mounts || "").split("\n").map((line) => {
      const [head, tail] = line.split(" - ");
      return { mountpoint: decode(head.split(" ")[4] || ""), filesystem: tail?.split(" ")[0] || null };
    }).filter((m) => m.mountpoint && (storagePath === m.mountpoint || storagePath.startsWith(m.mountpoint === "/" ? "/" : `${m.mountpoint}/`)))
      .sort((a, b) => b.mountpoint.length - a.mountpoint.length)[0];
    const memory = parseMeminfo(mem);
    return { cpuModel: label(cpus[0]?.["model name"] || cpus[0]?.["Processor"] || null), sockets: completeTopology ? sockets.size || null : null,
      physicalCores: completeTopology ? cores.size || null : null, logicalCpus, architecture: system.arch(),
      memoryTotalBytes: memory.memoryTotalBytes, swapTotalBytes: memory.swapTotalBytes,
      disks, gpus, network, boardVendor: label(dmi[0]), boardName: label(dmi[1]), biosVendor: label(dmi[2]), biosVersion: label(dmi[3]),
      osName: osRelease?.match(/^PRETTY_NAME=(.*)$/m)?.[1].replace(/^"|"$/g, "") || null,
      kernel: system.release(), storagePath, filesystem: mount?.filesystem || null,
      unavailableSources: [!logicalCpus && "CPU", !mem && "memory", !osRelease && "OS release", !mounts && "mounts"].filter(Boolean) };
  }
  return { collect, hardware };
}
