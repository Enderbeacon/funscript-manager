# Script player domain

The built-in script player is a bounded context. It turns the existing mpv
clock into device motion; it does not own media playback, the queue, sidecars,
or the renderer window.

Dependency direction:

```
interface -> application -> domain
                 ^
          infrastructure
```

- `domain`: pure script evaluation, axes, safety and TCode encoding. No Node,
  Electron, React, filesystem or network imports. The axis pipeline lives here:
  interpolation, stroke scale, inversion, per-axis offset, motion providers,
  auto-home, sync ease-in, the smart limit and the speed limit run once per
  axis and feed every output. Output ranges are applied downstream, so a
  device's limits never leak back into the script side.
- `application`: session orchestration and ports.
- `infrastructure`: mpv clock adapter, protected credentials, TCode transports
  and the separate The Handy v2 output adapter.
- `interface`: typed IPC and the shared React control surface.
- `composition`: the main-process singleton and dependency wiring.

There is one main-process session. The in-app panel and detached Electron
window are two views of that session; neither renderer controls hardware
directly.

TCode protocol reference: https://github.com/multiaxis/TCode-Specification

Parts of the axis pipeline are a derived implementation of third-party MIT
source. Which files, and where they came from, is recorded in
`THIRD_PARTY_NOTICES.md` — anything else copied or translated in has to be
added there with its origin and licence.
