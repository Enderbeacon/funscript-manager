# Third-party notices

## MultiFunPlayer

The built-in script player's output lifecycle, fixed/polled update behavior,
per-output range settings, auto-connect scan flow, TCode transport settings,
The Handy v2 connection flow, and output-tab information architecture were
implemented with reference to MultiFunPlayer source revision
`36c08fbb99ac9398a63ff1cca1bbf68cd2228a94`.

The axis value pipeline is a closer derivation of the same revision. These
carry upstream's formulas and constants rather than only its behavior:

- `src/script-player/domain/engine/interpolate.ts` — cubic Hermite, PCHIP and
  modified-Akima slopes, and the end-of-script neighbour extrapolation, from
  `Common/Utils/MathUtils.cs` and `Common/KeyframeCollection.cs`.
- `src/script-player/domain/engine/axis-pipeline.ts` — the order of script
  value, auto-home, sync ease-in and speed limit, their easing curves and
  their default timings, from `CalculateFinalValue` in
  `UI/Controls/ViewModels/ScriptViewModel.cs`.
- `src/script-player/domain/engine/evaluate.ts` — the per-axis cursor and its
  search/advance/before/after states, from the same file's `UpdateScript`;
  gap detection and the piecewise-linear lookup, from
  `Common/KeyframeCollection.cs` and `Common/Utils/MathUtils.cs`.
- `src/script-player/domain/engine/axis-pipeline.ts` also carries the motion
  provider blend, the follow-axis speed limit, the smart limit and per-axis
  auto-home from `CalculateFinalValue`.
- `src/script-player/domain/engine/script-engine.ts` — script scale and
  inversion, per-axis offset, motion provider gating and gap fill, from
  `UpdateScript` and `UpdateMotionProvider` in `ScriptViewModel.cs`.
- `src/script-player/domain/engine/noise.ts` — 2D OpenSimplex noise with its
  lattice, gradient table and seeded permutation, from `OpenSimplex` in
  `Common/Utils/MathUtils.cs`.
- `src/script-player/domain/engine/motion-providers.ts` — the random, pattern,
  custom curve and looping script providers, including the curve's tiling,
  from `MotionProvider/ViewModels/*.cs` and `MotionProvider/AbstractMotionProvider.cs`.

The per-axis tools in `src/script-player/interface/renderer/AxisPanel.tsx`,
`CurveEditor.tsx` and `AxisPreviews.tsx` follow the layout, defaults and
editing behavior of `UI/Controls/Views/ScriptView.xaml`, the motion provider
views, and `UI/Controls/DraggablePointCanvas.xaml.cs`,
`SmartLimitPreview.xaml.cs`, `InterpolationPreview.xaml.cs` and
`OpenSimplexPreview.xaml.cs` at the same revision; the link, lock, reload and
bypass rules in `script-player-session.ts` follow `SetScript`,
`UpdateLinkScriptFor` and `ReloadAxes` there.

Upstream:

https://github.com/Yoooi0/MultiFunPlayer

The MIT License (MIT)

Copyright (c) 2020 Yoooi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
