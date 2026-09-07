# Experiments

One file per commitment. The renderer mints every file here; the settler
reads the thresholds from the file, never from code. A threshold is fixed
when the file is minted and is never edited afterwards — a new bar means a
new file.

## Default bars for argon density-cone experiments (from 2026-09-07)

Set by the user on 2026-09-07 after the first three loops:

- `q05PinballRatio.improveIfDeltaAtMost: -0.01` on the holdout
  (origin=prospective). The Monte-Carlo noise floor measured by
  `2026-09-06-density-noise-floor` (sweep run 5) is 0.0015 on this metric,
  so 0.01 is about 7x noise. The earlier 0.03 bar was 20x noise and judged
  arm H's real 0.014 gain as flat.
- `meanPinball.regressIfDeltaAbove: 0.01`, unchanged.
- Second guard, stated in `rule`: no PR unless the decision set
  (origin=reconstructed) q05 ratio is not worse than the baseline run's.

The three 2026-09-06 files keep their 0.03 bar; their receipts stand.
