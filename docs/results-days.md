# Patterns across days

*Written by `npm run days` on 2026-11-17 23:31 UTC from `logs/ticks-*.jsonl`. One row per Minecraft day of MindBot's life; * = partial day (the bot was started, stopped or restarted). "Mind" is regions (Claude by day) or layers (the behaviour stack). Area = 8×8-block cells visited. Hurt = ticks it took damage. Starving = ticks with food at 3 or less. Most in control = share of ticks each layer had the body.*

| Day | Mind | Ticks | Walked | Area | Deaths | Hurt | Avg food | Starving | Ate | Hunted | Harvested | Broke | Made | Night enclosed % | Most in control |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 36 | layers | 762 | 759 | 64 | 1 | 8 | 18.4 | 22 | 0 | 0 | 0 | 3 | 0 | 100 | shelter 53%, make 35%, survive 12% |
| 37 | layers | 771 | 1890 | 120 | 0 | 11 | 3 | 565 | 3 | 10 | 0 | 9 | 0 | 100 | shelter 52%, make 29%, forage 17% |
| 38 | layers | 783 | 2070 | 123 | 0 | 2 | 1.7 | 766 | 2 | 0 | 0 | 3 | 0 | 100 | shelter 50%, forage 49%, survive 1% |
| 39 | layers | 776 | 1759 | 139 | 0 | 0 | 10.5 | 91 | 8 | 0 | 0 | 20 | 0 | 100 | shelter 51%, wander 27%, forage 13% |
| 40* | layers | 202 | 176 | 18 | 0 | 1 | 13.7 | 0 | 2 | 0 | 0 | 2 | 0 | — | forage 79%, make 20%, wander 1% |

## Trends over full days (4)

| Measure | Day 1 → latest |
|---|---|
| distance | `▁▇█▆` |
| area | `▁▆▇█` |
| deaths | `█▁▁▁` |
| avgFood | `█▂▁▅` |
| starvingTicks | `▁▆█▂` |
| ate | `▁▄▃█` |
| harvested | `▁▁▁▁` |
| made | `▁▁▁▁` |
| nightEnclosed | `▁▁▁▁` |
