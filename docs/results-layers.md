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
