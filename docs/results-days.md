# Patterns across days

*Written by `npm run days` on 2026-11-18 01:20 UTC from `logs/ticks-*.jsonl`. One row per Minecraft day of MindBot's life; * = partial day (the bot was started, stopped or restarted). "Mind" is regions (Claude by day) or layers (the behaviour stack). Area = 8×8-block cells visited. Hurt = ticks it took damage. Starving = ticks with food at 3 or less. Most in control = share of ticks each layer had the body.*

| Day | Mind | Ticks | Walked | Area | Deaths | Hurt | Avg food | Starving | Ate | Hunted | Harvested | Broke | Made | Night enclosed % | Most in control |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 38 | layers | 783 | 2070 | 123 | 0 | 2 | 1.7 | 766 | 2 | 0 | 0 | 3 | 0 | 100 | shelter 50%, forage 49%, survive 1% |
| 39 | layers | 776 | 1759 | 139 | 0 | 0 | 10.5 | 91 | 8 | 0 | 0 | 20 | 0 | 100 | shelter 51%, wander 27%, forage 13% |
| 40* | layers | 202 | 176 | 18 | 0 | 1 | 13.7 | 0 | 2 | 0 | 0 | 2 | 0 | — | forage 79%, make 20%, wander 1% |
| 41 | layers | 742 | 1655 | 134 | 0 | 0 | 12.1 | 0 | 7 | 11 | 6 | 20 | 0 | 100 | shelter 54%, make 22%, wander 21% |
| 42 | layers | 754 | 394 | 35 | 0 | 0 | 12.1 | 0 | 14 | 0 | 5 | 12 | 0 | 100 | shelter 53%, gather 25%, make 15% |
| 43* | layers | 461 | 1525 | 105 | 0 | 8 | 15.4 | 0 | 12 | 7 | 4 | 19 | 5 | 100 | make 29%, shelter 20%, wander 18% |
| 44* | layers | 252 | 0 | 1 | 0 | 0 | 17 | 0 | 0 | 0 | 0 | 0 | 0 | 100 | shelter 100% |
| 45* | layers | 325 | 619 | 53 | 0 | 1 | 16.7 | 0 | 2 | 0 | 2 | 14 | 0 | — | make 76%, wander 18%, gather 4% |

## Trends over full days (4)

| Measure | Day 1 → latest |
|---|---|
| distance | `█▇▆▁` |
| area | `▇██▁` |
| deaths | `▁▁▁▁` |
| avgFood | `▁▇██` |
| starvingTicks | `█▂▁▁` |
| ate | `▁▅▄█` |
| harvested | `▁▁█▇` |
| made | `▁▁▁▁` |
| nightEnclosed | `▁▁▁▁` |
