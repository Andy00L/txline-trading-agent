# Research: quant methods (de-vig, EV, Kelly, calibration, CLV)

Captured 2026-06-25 via an adversarially verified deep-research pass (105 agents, 23 primary/secondary sources fetched, 25 falsifiable claims voted, 22 confirmed, 3 refuted). This is the reference for the `core/quant` module. Each formula below is implemented exactly as stated; deviations are bugs.

Confidence tags reflect the verification votes: HIGH = unanimous (3-0) across independent primary sources; MEDIUM = split or inferred from adjacent verified claims; LOW = textbook-standard but not in the verified claim set (re-derive before trusting).

## 1. Multiplicative (basic) de-vig  [HIGH]

Given decimal odds `o_i` for the outcomes of a market, let the implied probability `r_i = 1 / o_i` and the booksum `B = sum_j r_j`. The fair probability is the proportional normalization:

```
p_i = r_i / B
```

- The overround (bookmaker margin) is `m = B - 1`. Do not conflate booksum (`B`) with margin (`B - 1`).
- Edge cases: guard against `o_i <= 0`. This method ignores the favourite-longshot bias (it overstates longshots, understates favourites), which is why it is the least accurate of the common methods.
- Sources: CRAN `implied` vignette and PDF (method "basic": `pi = ri / sum(r)`); Springer Annals of Operations Research 10.1007/s10479-022-04722-3; Hegarty and Whelan 2025 (Applied Economics, DOI 10.1080/00036846.2025.2507979).

## 2. Shin (1992/1993) de-vig  [HIGH]

Shin models a bookmaker facing a fraction `z` of insider traders. With `r_i = 1/o_i` and booksum `B = sum_j r_j`, the fair probability `p_i` is the positive root of the quadratic

```
(1 - z) p_i^2 + z p_i - r_i^2 / B = 0
```

which has the closed-form positive root

```
p_i(z) = ( sqrt( z^2 + 4 (1 - z) r_i^2 / B ) - z ) / ( 2 (1 - z) )
```

`z` (the insider-trading fraction) lies in `[0, 1)`; the model is degenerate at `z = 1` (the `(1 - z)` coefficient vanishes). Solve for the unique `z` that satisfies the constraint `sum_i p_i(z) = 1`.

- Solver: bisection on `z` over `[0, 1 - eps]`. The constraint function `g(z) = sum_i p_i(z) - 1` is monotone decreasing: `g(0) = sqrt(B) - 1 > 0` when there is margin (`B > 1`), and `g(z) -> sum_i r_i^2 / B - 1 < 0` as `z -> 1` (since each `r_i < 1`, so `sum r_i^2 < sum r_i = B`). A unique root exists in `(0, 1)`; bisection converges. This is the implementation in the canonical `mberk/shin` package and equals Whelan eq.12; the Cain-Law-Peel (1997/2001) fixed-point z-update is an equivalent alternative.
- Limiting behaviour: as `z -> 0` together with margin `-> 0` (`B -> 1`), Shin reduces to multiplicative normalization (`p_i = r_i / B`). At `z = 0`, `p_i = r_i / sqrt(B)`, which sums to 1 only when `B = 1`. State the reduction as the documented joint limit, not via the refuted square-root identity.
- CRITICAL: the bare quadratic WITHOUT the booksum factor, `(1 - z) p_i^2 + z p_i - r_i^2 = 0` (equivalently `- 1/o_i^2`), was REFUTED 0-3. The `r_i^2 / B` term (booksum normalization) is required. `B` is held fixed at `sum_j r_j` while bisecting `z`.
- Degenerate guard: if `B <= 1` (no margin or an underround), there is no insider correction to recover; fall back to multiplicative (`z = 0`).
- Why Shin over basic: Strumbelj (2014) shows Shin probabilities are more accurate than basic normalization or regression, and Shin endogenously corrects the favourite-longshot bias. Caveat (2-1): Shin is better than basic and regression but not universally best; the power/Khutsishvili method can match or beat it, and residual bias persists in some leagues. We default to Shin with multiplicative as the comparison baseline.
- Sources: Shin (1992) Economic Journal DOI 10.2307/2234526; Shin (1993) Economic Journal; Strumbelj (2014) Int. J. Forecasting 30(4):934-943, DOI 10.1016/j.ijforecast.2014.02.008; Whelan ShinzNov24 (Manchester School 2025); CRAN `implied`; `github.com/mberk/shin`.

## 3. Expected value of a single bet  [MEDIUM]

For fair probability `p` and offered decimal odds `o`, the expected value per unit staked is

```
EV = p * o - 1   (equivalently p * b - q, with b = o - 1, q = 1 - p)
```

The bet has positive expectation when `p * o > 1`, that is when the fair probability exceeds the offered implied probability `1/o`. Use the de-vigged fair `p`; using the raw implied `1/o` gives `EV <= 0` by construction of the overround. Textbook identity, consistent with Thorp's advantage condition `p*b - q > 0`; not independently vote-verified, hence MEDIUM.

## 4. Kelly criterion and fractional Kelly  [HIGH]

For a single bet at net decimal odds `b = o - 1`, win probability `p`, and `q = 1 - p`, the Kelly fraction that maximizes expected log growth `g(f) = p ln(1 + b f) + q ln(1 - f)` is

```
f_star = (b p - q) / b   (equivalently p - q / b)
```

Practice (all from Thorp 2006, Kelly 1956):

- Only bet when there is an edge: `b p - q > 0` (equivalently `p o > 1`); otherwise stake 0.
- Fractional Kelly: stake `f = c * f_star` for a constant `0 < c < 1` (margin of safety against estimation error).
- Clamp: `f = max(0, min(c * f_star, f_max))` where `f_max` caps exposure as a fraction of bankroll.
- Quantize: integer stake `= floor(f * bankroll)` in minor units; flooring avoids overbetting, and a stake that rounds to 0 means skip the bet.
- Rationale: overbetting is far more severely penalized than underbetting (it can drive expected log growth negative and cause ruin). Do NOT hardcode a specific fractional-Kelly growth-loss percentage: the common "half-Kelly sacrifices about 25 percent of growth" figure was REFUTED 0-3 in this pass. The directional overbetting-versus-underbetting asymmetry is solid.
- Sources: Kelly (1956) Bell System Technical Journal 35:917-926; Thorp (2006) "The Kelly Criterion in Blackjack, Sports Betting, and the Stock Market".

## 5. Calibration metrics

Let `p_i` be the predicted probability of the positive class and `y_i in {0,1}` the realized outcome over `N` samples.

- Log loss (cross-entropy) [HIGH]: `LogLoss = -(1/N) sum_i [ y_i ln(p_i) + (1 - y_i) ln(1 - p_i) ]`, natural log. Clip `p_i` to `[eps, 1 - eps]` (eps about 1e-15) to avoid `ln(0)`. Source: scikit-learn `log_loss` docs.
- Brier score [LOW, textbook]: `Brier = (1/N) sum_i (p_i - y_i)^2`, the mean squared error; range `[0,1]` for binary, lower is better. Confirm against Brier (1950) Monthly Weather Review and sklearn `brier_score_loss`; not in the verified claim set, so re-checked by hand here.
- Reliability (calibration) curve [HIGH]: discretize `[0,1]` into bins; for each bin plot the mean predicted probability (x) against the fraction of positives (y). A perfectly calibrated forecaster lies on `y = x`. Bin count and strategy (uniform versus quantile width) affect the curve's variance. Source: scikit-learn `calibration_curve` and calibration user guide; Niculescu-Mizil and Caruana (2005).

## 6. Closing Line Value (CLV)  [LOW, practitioner consensus]

CLV measures whether the price obtained beat the market's closing price for the same outcome. With our consensus-only feed, the "closing line" is the last pre-kickoff StablePrice consensus and the "entry" is the consensus at decision time.

- Odds-based: `CLV_odds = entry_odds / closing_odds - 1`. Positive means the entry secured higher decimal odds than the close (beat the line).
- Probability-based: `CLV_prob = closing_fair_prob - entry_fair_prob`, comparing de-vigged probabilities (de-vig both sides the same way). Positive means the entry implied a lower probability than the sharper closing estimate, an edge signal.
- Why it is an edge proxy: the closing line is the most information-efficient price (it aggregates maximum information and sharp money), so consistently beating it is statistically associated with positive expected value. This is the primary edge metric for the backtest given consensus-only data.
- Caveat: compare like for like (same outcome and market, de-vig both sides identically). Not in the verified claim set (the dedicated CLV claim was a coverage gap); definitions are the standard practitioner framing (Buchdahl, Pinnacle) with theoretical support from market-efficiency results (Hegarty and Whelan 2025). Treat as LOW confidence and revisit with a dedicated empirical source if needed.

## Implementation notes (how this maps to code)

- Inputs are `DecimalOddsMilli` (odds times 1000). `r_i = decimalOddsMilliToProb(oddsMilli) = 1000 / oddsMilli`, already a `Prob` in `(0,1)`.
- All functions are pure and deterministic (no clock, no RNG); the Shin bisection is a fixed-iteration loop with a tolerance, so the same odds always yield the same `z`.
- Errors are values: empty market, non-positive or degenerate odds, and non-convergence each return a distinct `QuantError`.
- Golden tests pin: a multiplicative worked example; a Shin worked example with a checked `z`; the property that Shin sums to 1 and `z in [0,1)`; the property that Shin approaches multiplicative as the margin approaches 0; EV and Kelly worked examples including the no-edge (stake 0) and cap paths; Brier and log-loss worked examples; and a calibration curve on a synthetic calibrated sample.

## Open questions deferred (from the research pass)

- A dedicated empirical CLV source to lift item 6 above LOW confidence.
- Whether to add the power/Khutsishvili de-vig method as an alternative (Clarke et al. 2017 found it can match or beat Shin). Not needed for the primary scope; multiplicative plus Shin is sufficient and defensible.
