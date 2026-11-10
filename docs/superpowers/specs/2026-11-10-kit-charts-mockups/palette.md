# Chart palette validation

| Token | Light | Dark | Wada source |
|---|---|---|---|
| --chart-1 | #e69500 | #ffaa00 | theme orange; light darkened |
| --chart-2 | #006eb8 | #5aa6e6 | Blue #006eb8 (combos 257, 267); dark lightened |
| --chart-3 | #00978d | #3cc9a8 | Benzol Green #00978d (combo 267, with Orange Yellow/Yellow Orange); dark lifted, hue nudged greener for separation from blue |
| --chart-4 | #8a2f7a | #b85aa6 | Red Violet #59256a (combo 170, with Orange Yellow); lifted step to enter the lightness band |

Combo 170 = Orange Yellow + Red Violet; 267 = Yellow Orange/Cream Yellow/Blue/Benzol Green.

## Light (surface #f1f1f1)
```

Palette (light, surface #f1f1f1, categorical): 4 slots
  [PASS] Lightness band         all 4 inside L 0.43–0.77
  [PASS] Chroma floor           all 4 >= 0.1
  [PASS] CVD separation         worst all-pairs #8a2f7a↔#006eb8 ΔE 10.2 (deutan) · tritan 8.0
  [PASS] Normal-vision floor    worst all-pairs #00978d↔#006eb8 ΔE 15.5 (normal)
  [WARN] Contrast vs surface    below 3:1 — relief required (visible labels or table view): [["#e69500",2.15]]

  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
  scope: categorical palettes only. For a lone status/text color check text contrast with this script's apca() or contrast(); for a sequential ramp, lightness monotonicity.

```

## Dark (surface #171717)
```

Palette (dark, surface #171717, categorical): 4 slots
  [FAIL] Lightness band         outside band: [["#ffaa00",0.802],["#5aa6e6",0.703],["#3cc9a8",0.753]]
  [PASS] Chroma floor           all 4 >= 0.1
  [PASS] CVD separation         worst all-pairs #b85aa6↔#5aa6e6 ΔE 10.6 (deutan) · tritan 6.3
  [PASS] Normal-vision floor    worst all-pairs #3cc9a8↔#5aa6e6 ΔE 15.6 (normal)
  [PASS] Contrast vs surface    all 4 >= 3:1

  → FAILED — fix the marked checks  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
  scope: categorical palettes only. For a lone status/text color check text contrast with this script's apca() or contrast(); for a sequential ramp, lightness monotonicity.

```

Accepted: orange contrast WARN (light), orange lightness-band FAIL (dark), and the dark lightness-band misses for `#5aa6e6` (spec-mandated) and `#3cc9a8` (a tradeoff for colorblind separation).
