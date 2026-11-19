#!/usr/bin/env python3
"""95% intervals for the Evidence ledger. Standard library only; any Python 3.8 or later.

  python3 evidence/interval.py wilson K N
      Wilson interval for K successes out of N (a rate, such as 14 of 20 flagged).
  python3 evidence/interval.py mean FILE.csv COLUMN
      Bootstrap interval for the mean of one CSV column.
  python3 evidence/interval.py diff FILE.csv COLUMN_A COLUMN_B [--unpaired]
      Bootstrap interval for mean(A) - mean(B). Paired by default: each row is one item
      scored both ways (ours and the baseline), and rows missing either value are skipped.
      With --unpaired, each column is resampled on its own.

Options: --level 0.95 (any level between 0 and 1), --draws 10000 and --seed 7 (bootstrap
only; the seed makes the interval the same on every rerun).

COLUMN is a header name, or a 1-based column number. Blank cells are skipped. Cells may be
numbers, or yes/no and true/false (read as 1 and 0). The bootstrap interval is the
percentile interval of the resampled means.
"""
import argparse
import csv
import math
import random
import statistics
import sys

TRUE = {"yes", "true", "y", "t"}
FALSE = {"no", "false", "n", "f"}


def z_for(level):
    return statistics.NormalDist().inv_cdf(0.5 + level / 2.0)


def wilson(k, n, level=0.95):
    """(low, high) of the Wilson score interval for k successes in n trials."""
    if n <= 0 or k < 0 or k > n:
        raise ValueError("need 0 <= K <= N and N > 0")
    z = z_for(level)
    p = k / float(n)
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4.0 * n * n)) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


def percentile(sorted_xs, q):
    k = (len(sorted_xs) - 1) * q
    lo = int(math.floor(k))
    hi = min(lo + 1, len(sorted_xs) - 1)
    return sorted_xs[lo] + (sorted_xs[hi] - sorted_xs[lo]) * (k - lo)


def bootstrap(stat, samples, draws, seed, level):
    """Percentile interval of stat over resamples (each sample list resampled with replacement)."""
    rnd = random.Random(seed)
    vals = []
    for _ in range(draws):
        vals.append(stat([[s[rnd.randrange(len(s))] for _ in s] for s in samples]))
    vals.sort()
    a = (1 - level) / 2.0
    return percentile(vals, a), percentile(vals, 1 - a)


def number(cell, where):
    c = cell.strip()
    if c.lower() in TRUE:
        return 1.0
    if c.lower() in FALSE:
        return 0.0
    try:
        return float(c.replace(",", ""))
    except ValueError:
        sys.exit("interval.py: %s: %r isn't a number, yes/no or true/false" % (where, cell))


def read_columns(path, names):
    """The values of each named column, row by row (None for a blank cell)."""
    try:
        f = open(path, newline="", encoding="utf-8-sig")
    except OSError as e:
        sys.exit("interval.py: can't read %s: %s" % (path, e))
    with f:
        rows = list(csv.reader(f))
    if not rows:
        sys.exit("interval.py: %s is empty" % path)
    header = [h.strip() for h in rows[0]]
    idx = []
    for name in names:
        if name in header:
            idx.append(header.index(name))
        elif name.isdigit() and 1 <= int(name) <= len(header):
            idx.append(int(name) - 1)
        else:
            sys.exit("interval.py: %s has no column %r (columns: %s)" % (path, name, ", ".join(header)))
    cols = [[] for _ in names]
    for r, row in enumerate(rows[1:], 2):
        for j, i in enumerate(idx):
            cell = row[i] if i < len(row) else ""
            cols[j].append(None if not cell.strip() else number(cell, "%s row %d, column %s" % (path, r, names[j])))
    return cols


def fmt(x):
    return "%.4g" % x


def main(argv=None):
    ap = argparse.ArgumentParser(description="95% intervals for the Evidence ledger (see the top of this file).")
    sub = ap.add_subparsers(dest="cmd")
    sub.required = True
    w = sub.add_parser("wilson", help="Wilson interval for K of N")
    w.add_argument("k", type=int)
    w.add_argument("n", type=int)
    m = sub.add_parser("mean", help="bootstrap interval for a column's mean")
    m.add_argument("csv")
    m.add_argument("column")
    d = sub.add_parser("diff", help="bootstrap interval for mean(A) - mean(B)")
    d.add_argument("csv")
    d.add_argument("column_a")
    d.add_argument("column_b")
    d.add_argument("--unpaired", action="store_true")
    for p in (w, m, d):
        p.add_argument("--level", type=float, default=0.95)
    for p in (m, d):
        p.add_argument("--draws", type=int, default=10000)
        p.add_argument("--seed", type=int, default=7)
    a = ap.parse_args(argv)
    if not 0 < a.level < 1:
        ap.error("--level must be between 0 and 1")
    pct = "%g%%" % (a.level * 100)

    if a.cmd == "wilson":
        try:
            lo, hi = wilson(a.k, a.n, a.level)
        except ValueError as e:
            ap.error(str(e))
        print("%d of %d = %.1f%% (%s Wilson interval %.1f%% to %.1f%%)" % (a.k, a.n, 100.0 * a.k / a.n, pct,
                                                                           100 * lo, 100 * hi))
        return 0

    if a.draws < 100:
        ap.error("--draws must be at least 100")
    if a.cmd == "mean":
        xs = [x for x in read_columns(a.csv, [a.column])[0] if x is not None]
        if len(xs) < 2:
            sys.exit("interval.py: column %s has %d value(s); a bootstrap needs at least 2" % (a.column, len(xs)))
        lo, hi = bootstrap(lambda s: statistics.fmean(s[0]), [xs], a.draws, a.seed, a.level)
        print("mean of %s = %s over n=%d (%s bootstrap interval %s to %s; %d draws, seed %d)" % (
            a.column, fmt(statistics.fmean(xs)), len(xs), pct, fmt(lo), fmt(hi), a.draws, a.seed))
        return 0

    col_a, col_b = read_columns(a.csv, [a.column_a, a.column_b])
    if a.unpaired:
        xa = [x for x in col_a if x is not None]
        xb = [x for x in col_b if x is not None]
        if len(xa) < 2 or len(xb) < 2:
            sys.exit("interval.py: each column needs at least 2 values (%s has %d, %s has %d)" % (
                a.column_a, len(xa), a.column_b, len(xb)))
        est = statistics.fmean(xa) - statistics.fmean(xb)
        lo, hi = bootstrap(lambda s: statistics.fmean(s[0]) - statistics.fmean(s[1]), [xa, xb], a.draws, a.seed, a.level)
        how = "unpaired, n=%d and n=%d" % (len(xa), len(xb))
    else:
        pairs = [x - y for x, y in zip(col_a, col_b) if x is not None and y is not None]
        if len(pairs) < 2:
            sys.exit("interval.py: %d row(s) have both %s and %s; a bootstrap needs at least 2" % (
                len(pairs), a.column_a, a.column_b))
        est = statistics.fmean(pairs)
        lo, hi = bootstrap(lambda s: statistics.fmean(s[0]), [pairs], a.draws, a.seed, a.level)
        how = "paired, n=%d rows" % len(pairs)
    print("mean %s - mean %s = %s (%s; %s bootstrap interval %s to %s; %d draws, seed %d)" % (
        a.column_a, a.column_b, fmt(est), how, pct, fmt(lo), fmt(hi), a.draws, a.seed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
