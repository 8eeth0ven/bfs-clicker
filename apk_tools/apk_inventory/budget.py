"""Parent-side resident-memory monitoring, including macOS workers."""
from __future__ import annotations

import subprocess


def rss_tree(pid: int) -> int:
    try:
        import psutil
        try:
            process = psutil.Process(pid)
            processes = [process, *process.children(recursive=True)]
            total = 0
            for child in processes:
                try:
                    total += child.memory_info().rss
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
            return total
        except psutil.NoSuchProcess:
            return 0
    except ImportError:
        # A stdlib POSIX fallback keeps the minimal/offline scanner usable.
        result = subprocess.run(["ps", "-axo", "pid=,ppid=,rss="], capture_output=True, text=True, timeout=2, check=True)
        rows = [tuple(map(int, line.split())) for line in result.stdout.splitlines() if len(line.split()) == 3]
        selected = {pid}
        for _ in range(len(rows)):
            children = {p for p, parent, _ in rows if parent in selected}
            if children <= selected:
                break
            selected |= children
        return sum(rss * 1024 for process, _, rss in rows if process in selected)
