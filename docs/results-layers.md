# Learned layers

*Written by `npm run train-layers`. Each run fits the layers on MindBot's own days, holds out the latest day, and serves a layer only if it beats the hand-written one there (balanced accuracy over acts that worked and moments to stay quiet). Model files: `logs/layers/`.*

## 2026-11-17 23:43 UTC

**forage v1:** not served (did not beat the hand-written layer by 0.03 (0.403 vs 1)).
- 246 examples to learn from, 202 held out (the latest day). Balanced accuracy 0.403 vs the hand-written layer's 1.
- Held-out examples by act: seekFood 35, pickup 4, none 158, harvest 5.
- Right per act, learned: seekFood 100%, pickup 0%, none 61%, harvest 0%; hand-written: seekFood 100%, pickup 100%, none 100%, harvest 100%.
- Strongest weights: eat (carriesNoFood -0.478, curiosity -0.459, day -0.443); pickup (carriesNoFood -0.478, curiosity -0.459, day -0.443); harvest (carriesNoFood -0.478, curiosity -0.459, day -0.443); hunt (animalClose +3.532, fear +3.041, health +1.187); seekFood (health -3.291, fear -2.432, animalClose -2.124).

**wander:** not served (not enough examples yet (1 to learn from, 216 to test on; need 60 and 30)).

## 2026-11-17 23:43 UTC

**forage v2:** not served (did not beat the hand-written layer by 0.03 (0.383 vs 1)).
- 277 examples to learn from, 204 held out (the latest day). Balanced accuracy 0.383 vs the hand-written layer's 1.
- Held-out examples by act: seekFood 35, pickup 4, none 160, harvest 5.
- Right per act, learned: seekFood 100%, pickup 0%, none 53%, harvest 0%; hand-written: seekFood 100%, pickup 100%, none 100%, harvest 100%.
- Strongest weights: eat (carriesNoFood -0.483, curiosity -0.473, day -0.445); pickup (carriesNoFood -0.483, curiosity -0.473, day -0.445); harvest (carriesNoFood -0.483, curiosity -0.473, day -0.445); hunt (animalClose +2.865, edgeClose +2.61, fear +2.299); seekFood (health -3.429, fear -2.156, hunger +1.803).

## 2026-11-17 23:54 UTC

**forage v3:** not served (did not beat the hand-written layer by 0.03 (0.62 vs 1)).
- 453 examples to learn from, 114 held out (the latest day). Balanced accuracy 0.62 vs the hand-written layer's 1.
- Held-out examples by act: none 101, harvest 11, pickup 2.
- Right per act, learned: none 86%, harvest 0%, pickup 100%; hand-written: none 100%, harvest 100%, pickup 100%.
- Strongest weights: eat (curiosity -0.615, day -0.567, hunger -0.357); pickup (ripeCropClose +3.826, carriesNoFood -1.754, edgeClose -1.056); harvest (curiosity -0.615, day -0.567, hunger -0.357); hunt (animalClose +2.818, health +2.235, edgeClose +2.208); seekFood (health -2.505, hunger +1.877, carriesNoFood +1.79).

**wander v1:** not served (did not beat the hand-written layer by 0.03 (0.492 vs 0.667)).
- 214 examples to learn from, 155 held out (the latest day). Balanced accuracy 0.492 vs the hand-written layer's 0.667.
- Held-out examples by act: explore 130, fiddle 23, none 2.
- Right per act, learned: explore 58%, fiddle 39%, none 50%; hand-written: explore 100%, fiddle 100%, none 0%.
- Strongest weights: explore (foodCarried -2.174, curiosity +0.995, day +0.995); fiddle (ripeCropClose +0.964, food +0.888, animalClose +0.671); approach (curiosity -0.818, day -0.818, foodCarried -0.562); idle (curiosity -0.818, day -0.818, foodCarried -0.562).

## 2026-11-17 23:54 UTC

**forage v4:** not served (did not beat the hand-written layer by 0.03 (0.622 vs 1)).
- 453 examples to learn from, 118 held out (the latest day). Balanced accuracy 0.622 vs the hand-written layer's 1.
- Held-out examples by act: none 105, harvest 11, pickup 2.
- Right per act, learned: none 87%, harvest 0%, pickup 100%; hand-written: none 100%, harvest 100%, pickup 100%.
- Strongest weights: eat (curiosity -0.615, day -0.567, hunger -0.357); pickup (ripeCropClose +3.826, carriesNoFood -1.754, edgeClose -1.056); harvest (curiosity -0.615, day -0.567, hunger -0.357); hunt (animalClose +2.818, health +2.235, edgeClose +2.208); seekFood (health -2.505, hunger +1.877, carriesNoFood +1.79).

**wander v2:** not served (did not beat the hand-written layer by 0.03 (0.492 vs 0.667)).
- 214 examples to learn from, 155 held out (the latest day). Balanced accuracy 0.492 vs the hand-written layer's 0.667.
- Held-out examples by act: explore 130, fiddle 23, none 2.
- Right per act, learned: explore 58%, fiddle 39%, none 50%; hand-written: explore 100%, fiddle 100%, none 0%.
- Strongest weights: explore (foodCarried -2.174, curiosity +0.995, day +0.995); fiddle (ripeCropClose +0.964, food +0.888, animalClose +0.671); approach (curiosity -0.818, day -0.818, foodCarried -0.562); idle (curiosity -0.818, day -0.818, foodCarried -0.562).

## 2026-11-17 23:59 UTC

**forage v6:** not served (did not beat the hand-written layer by 0.03 (0.633 vs 1)).
- 433 examples to learn from, 153 held out (the latest day). Balanced accuracy 0.633 vs the hand-written layer's 1.
- Held-out examples by act: none 140, harvest 11, pickup 2.
- Right per act, learned: none 90%, harvest 0%, pickup 100%; hand-written: none 100%, harvest 100%, pickup 100%.
- Strongest weights: eat (curiosity -0.614, day -0.569, hunger -0.367); pickup (ripeCropClose +3.815, carriesNoFood -1.759, edgeClose -1.052); harvest (curiosity -0.614, day -0.569, hunger -0.367); hunt (animalClose +3.123, health +2.579, edgeClose +2.275); seekFood (health -2.566, hunger +1.885, carriesNoFood +1.767).

**wander v4:** not served (did not beat the hand-written layer by 0.03 (0.489 vs 0.667)).
- 214 examples to learn from, 155 held out (the latest day). Balanced accuracy 0.489 vs the hand-written layer's 0.667.
- Held-out examples by act: explore 130, fiddle 23, none 2.
- Right per act, learned: explore 58%, fiddle 39%, none 50%; hand-written: explore 100%, fiddle 100%, none 0%.
- Strongest weights: explore (foodCarried -2.147, curiosity +0.956, day +0.956); fiddle (ripeCropClose +0.874, food +0.789, animalClose +0.652); approach (curiosity -0.814, day -0.814, foodCarried -0.564); idle (curiosity -0.814, day -0.814, foodCarried -0.564).
