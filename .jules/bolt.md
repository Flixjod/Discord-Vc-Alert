## 2025-05-14 - [sc Formatting Layer Removal]
**Learning:** The `sc()` (small caps) formatting layer, while visually pleasing, introduced a significant performance penalty (~400x slower than static strings) and increased memory pressure due to constant string manipulation in hot paths. Pre-rendering static labels and removing the dynamic layer entirely is a massive win for low-resource environments.
**Action:** Always pre-render static Unicode text instead of using runtime transformation functions for cosmetic UI elements.
