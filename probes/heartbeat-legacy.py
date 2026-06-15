import os, datetime, time, sys
layers = [
    ("AGENTS.md", ".", False),
    ("README.md", ".", False),
]

def file_summary(path):
    try:
        size = os.path.getsize(path)
        with open(path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        return f"{len(lines)} lines, {size} bytes"
    except Exception as e:
        return f"ERROR_READING::{e}"


for name, dirpath, recursive in layers:
    full_dir = os.path.abspath(dirpath)
    print(f"LAYER::{name}::DIR::{full_dir}::recursive={recursive}")
    print(f"LAYER::{name}::SUMMARY::{file_summary(os.path.join(full_dir, name))}")
    print()
