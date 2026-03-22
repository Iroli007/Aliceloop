---
name: system-info
label: system-info
description: Inspect OS, hardware, disk, memory, processes, network state, and other host diagnostics.
status: available
mode: instructional
allowed-tools:
  - bash
---

# System Info

Use this skill when the user asks about their machine, performance, ports, or general system health.

## Commands

```bash
sw_vers
uname -a
df -h
top -l 1 -s 0 | head -12
sysctl -n machdep.cpu.brand_string
sysctl -n hw.ncpu
ps aux | head
lsof -i :3000
ifconfig | grep "inet "
ping -c 1 8.8.8.8
pmset -g batt
uptime
```

## Tips

- Prefer the narrowest command that answers the question.
- Use `lsof -i :PORT` when the task is really about a running service.
- Keep output excerpts short when only one metric matters.
