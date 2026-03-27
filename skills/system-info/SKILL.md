---
name: system-info
label: system-info
description: Get system information -- OS version, disk usage, memory, running processes, network status.
status: available
mode: instructional
allowed-tools:
  - bash
---

# System Info

Gather system information using standard command-line tools.

## Commands

```bash
date
uptime

sw_vers
uname -a
df -h
du -sh ~/Desktop ~/Documents ~/Downloads
vm_stat
top -l 1 -s 0 | head -12
sysctl -n machdep.cpu.brand_string
sysctl -n hw.ncpu
ps aux | head -10
ps aux --sort=-%cpu | head -10
lsof -i :3000
ifconfig | grep "inet "
networksetup -getairportnetwork en0
ping -c 1 8.8.8.8
pmset -g batt
```

## Tips

- Prefer the narrowest command that answers the question.
- Use `date` for the current local clock and `uptime` for a quick host-health read.
- Use `lsof -i :PORT` when the task is really about a running service.
- Keep output excerpts short when only one metric matters.
