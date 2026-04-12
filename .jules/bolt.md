## 2025-05-22 - Zero-Overhead Static Labels
**Learning:** While memoizing the `sc` function provides a ~70x speedup, static labels can be optimized further by hardcoding the pre-rendered small-caps strings directly in the source code. This eliminates function call overhead and cache lookups entirely for hot UI paths.
**Action:** Replace static `sc("...")` calls with pre-rendered Unicode equivalents. Retain memoized `sc()` only for dynamic content (guild names, user tags, timestamps).
