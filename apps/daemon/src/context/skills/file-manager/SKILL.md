---
name: file-manager
label: file-manager
description: Find, inspect, organize, rename, compress, and move files on the local machine.
status: available
mode: instructional
allowed-tools:
  - bash
  - read
  - write
  - grep
  - glob
---

# File Manager

Use this skill when the task is mainly about local files rather than application code.

## When to Use

- finding files by name, extension, size, or recency
- moving or renaming groups of files
- creating archives or unpacking downloads
- checking what will be affected before a bulk operation

## Commands

```bash
find ~/Desktop ~/Documents ~/Downloads -iname "*report*" -type f 2>/dev/null
find ~/Downloads -name "*.pdf" -type f
find ~ -size +100M -type f 2>/dev/null | head -20
find ~/Documents -mtime -7 -type f | head -20

mkdir -p ~/Documents/$(date +%Y-%m-%d)
mv ~/Downloads/*.pdf ~/Documents/
for f in *.jpeg; do mv "$f" "${f%.jpeg}.jpg"; done

zip -r archive.zip folder/
tar czf archive.tar.gz folder/
unzip archive.zip
tar xzf archive.tar.gz
```

## Tips

- Preview file lists before bulk edits.
- Ask before deleting or overwriting user files.
- Prefer safe moves or archives over destructive cleanup.
